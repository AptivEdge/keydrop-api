import {
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmailService } from '../email/email.service.js';

const ACCESS_TOKEN_TTL_SECONDS = 5 * 60;
const CODE_TTL_MINUTES = 10;
const CODE_MAX_ATTEMPTS = 5;
const CODE_RESEND_SECONDS = 60;

interface AccessTokenPayload {
  sub: string;
  recipient_email_hash: string;
  iat: number;
  exp: number;
  jti: string;
}

@Injectable()
export class RecipientAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
  ) {}

  async sendCode(secretId: string): Promise<{ sent: true }> {
    validateSecretId(secretId);
    const now = new Date();
    const code = randomInt(100000, 1000000).toString();
    const issue = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Secret" WHERE "id" = ${secretId} FOR UPDATE
      `;
      if (!locked.length) throw new GoneException('Secret is unavailable');

      const secret = await tx.secret.findUnique({
        where: { id: secretId },
        select: {
          status: true,
          expiresAt: true,
          recipientEmail: true,
          recipientEmailHash: true,
        },
      });
      if (
        !secret ||
        !['active', 'partially_viewed'].includes(secret.status) ||
        (secret.expiresAt && secret.expiresAt <= now)
      ) {
        throw new GoneException('Secret is unavailable');
      }
      if (!secret.recipientEmail || !secret.recipientEmailHash) {
        throw new ConflictException(
          'This secret does not require recipient verification',
        );
      }

      const recent = await tx.emailOtp.findFirst({
        where: {
          secretId,
          consumedAt: null,
          createdAt: {
            gte: new Date(now.getTime() - CODE_RESEND_SECONDS * 1000),
          },
        },
        select: { id: true },
      });
      if (recent) return { otp: null, email: secret.recipientEmail };

      await tx.emailOtp.updateMany({
        where: { secretId, consumedAt: null },
        data: { consumedAt: now },
      });
      const otp = await tx.emailOtp.create({
        data: {
          secretId,
          email: secret.recipientEmail,
          codeHash: this.hashCode(code),
          expiresAt: new Date(now.getTime() + CODE_TTL_MINUTES * 60 * 1000),
          maxAttempts: CODE_MAX_ATTEMPTS,
        },
        select: { id: true },
      });
      return { otp, email: secret.recipientEmail };
    });
    if (!issue.otp) {
      throw new HttpException(
        'Please wait before requesting another verification code',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    try {
      await this.email.send({
        to: issue.email,
        template: 'recipient_access',
        variables: { CODE: code, EXPIRY_MINUTES: CODE_TTL_MINUTES },
      });
    } catch {
      await this.consumeCode(issue.otp.id);
      throw new ServiceUnavailableException(
        'Unable to deliver recipient verification code',
      );
    }

    await this.prisma.auditEvent.create({
      data: { eventType: 'email_code_sent', secretId },
    });
    return { sent: true };
  }

  async verifyCode(
    secretId: string,
    code: string,
  ): Promise<{ access_token: string; expires_in: number }> {
    validateSecretId(secretId);
    const now = new Date();
    const otp = await this.prisma.emailOtp.findFirst({
      where: {
        secretId,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp || otp.attempts >= otp.maxAttempts) {
      throw this.invalidCode();
    }

    if (!safeCompare(otp.codeHash, this.hashCode(code))) {
      await this.prisma.emailOtp.updateMany({
        where: {
          id: otp.id,
          consumedAt: null,
          attempts: { lt: otp.maxAttempts },
          expiresAt: { gt: now },
        },
        data: { attempts: { increment: 1 } },
      });
      await this.prisma.auditEvent.create({
        data: { eventType: 'email_code_failed', secretId },
      });
      throw this.invalidCode();
    }

    const consumed = await this.prisma.emailOtp.updateMany({
      where: {
        id: otp.id,
        consumedAt: null,
        attempts: { lt: otp.maxAttempts },
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) {
      throw this.invalidCode();
    }

    const secret = await this.prisma.secret.findUnique({
      where: { id: secretId },
      select: { status: true, expiresAt: true, recipientEmailHash: true },
    });
    if (
      !secret ||
      !secret.recipientEmailHash ||
      !['active', 'partially_viewed'].includes(secret.status) ||
      (secret.expiresAt && secret.expiresAt <= now)
    ) {
      throw new GoneException('Secret is unavailable');
    }

    await this.prisma.auditEvent.create({
      data: { eventType: 'email_verified', secretId },
    });
    return {
      access_token: this.createToken(secretId, secret.recipientEmailHash),
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  async verify(secretId: string, token: string): Promise<void> {
    validateSecretId(secretId);
    const payload = this.parseToken(token);
    if (
      payload.sub !== secretId ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      throw new UnauthorizedException(
        'Recipient access token is invalid or expired',
      );
    }
    const secret = await this.prisma.secret.findUnique({
      where: { id: secretId },
      select: { recipientEmailHash: true, status: true, expiresAt: true },
    });
    if (
      !secret ||
      !secret.recipientEmailHash ||
      secret.recipientEmailHash !== payload.recipient_email_hash ||
      !['active', 'partially_viewed'].includes(secret.status) ||
      (secret.expiresAt && secret.expiresAt <= new Date())
    ) {
      throw new UnauthorizedException(
        'Recipient access token is invalid or expired',
      );
    }
  }

  private createToken(secretId: string, recipientEmailHash: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const payload: AccessTokenPayload = {
      sub: secretId,
      recipient_email_hash: recipientEmailHash,
      iat: now,
      exp: now + ACCESS_TOKEN_TTL_SECONDS,
      jti: randomBytes(16).toString('hex'),
    };
    const encodedPayload = encode(payload);
    const unsigned = `${header}.${encodedPayload}`;
    return `${unsigned}.${this.sign(unsigned)}`;
  }

  private parseToken(token: string): AccessTokenPayload {
    const [header, payload, signature, extra] = token.split('.');
    if (!header || !payload || !signature || extra) {
      throw new UnauthorizedException(
        'Recipient access token is invalid or expired',
      );
    }
    const unsigned = `${header}.${payload}`;
    if (!safeCompare(signature, this.sign(unsigned))) {
      throw new UnauthorizedException(
        'Recipient access token is invalid or expired',
      );
    }
    try {
      const parsedHeader = JSON.parse(
        Buffer.from(header, 'base64url').toString('utf8'),
      ) as { alg?: unknown; typ?: unknown };
      const parsed = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as Partial<AccessTokenPayload>;
      if (
        parsedHeader.alg !== 'HS256' ||
        parsedHeader.typ !== 'JWT' ||
        typeof parsed.sub !== 'string' ||
        typeof parsed.recipient_email_hash !== 'string' ||
        typeof parsed.iat !== 'number' ||
        typeof parsed.exp !== 'number' ||
        typeof parsed.jti !== 'string'
      ) {
        throw new Error('Malformed token');
      }
      return parsed as AccessTokenPayload;
    } catch {
      throw new UnauthorizedException(
        'Recipient access token is invalid or expired',
      );
    }
  }

  private hashCode(code: string): string {
    return createHmac('sha256', this.getTokenSecret())
      .update(code)
      .digest('hex');
  }

  private sign(value: string): string {
    return createHmac('sha256', this.getTokenSecret())
      .update(value)
      .digest('base64url');
  }

  private getTokenSecret(): string {
    const secret = this.config.get<string>('RECIPIENT_ACCESS_TOKEN_SECRET');
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
      throw new ServiceUnavailableException(
        'RECIPIENT_ACCESS_TOKEN_SECRET must contain at least 32 bytes',
      );
    }
    return secret;
  }

  private consumeCode(id: string): Promise<unknown> {
    return this.prisma.emailOtp.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  }

  private invalidCode(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'code_invalid',
      message: 'Verification code is invalid or expired',
    });
  }
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function validateSecretId(id: string): void {
  if (!/^[0-9A-Za-z]{22}$/.test(id) && !/^[a-z0-9]{25}$/.test(id)) {
    throw new NotFoundException('Secret not found');
  }
}
