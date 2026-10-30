import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { EmailOtpPurpose } from '../../../generated/prisma/enums.js';
import { PrismaService } from '../../../prisma/prisma.service.js';

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_SECONDS = 60;

export class EmailOtpCooldownException extends HttpException {
  constructor() {
    super(
      'Please wait before requesting another verification code',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

@Injectable()
export class EmailOtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async issue(
    email: string,
    purpose: EmailOtpPurpose,
    identitySubject?: string,
  ): Promise<{ code: string }> {
    const normalizedEmail = normalizeEmail(email);
    const now = new Date();
    const recent = await this.prisma.emailOtp.findFirst({
      where: {
        email: normalizedEmail,
        purpose,
        createdAt: { gte: new Date(now.getTime() - OTP_RESEND_SECONDS * 1000) },
        consumedAt: null,
      },
      select: { id: true },
    });

    if (recent) {
      throw new EmailOtpCooldownException();
    }

    const code = randomInt(100000, 1000000).toString();
    const codeHash = this.hashCode(code);
    await this.prisma.emailOtp.updateMany({
      where: { email: normalizedEmail, purpose, consumedAt: null },
      data: { consumedAt: now },
    });

    await this.prisma.emailOtp.create({
      data: {
        email: normalizedEmail,
        identitySubject,
        purpose,
        codeHash,
        expiresAt: new Date(now.getTime() + OTP_TTL_MINUTES * 60 * 1000),
        maxAttempts: OTP_MAX_ATTEMPTS,
      },
    });

    return { code };
  }

  async cancel(
    email: string,
    purpose: EmailOtpPurpose,
    identitySubject: string,
  ): Promise<void> {
    await this.prisma.emailOtp.updateMany({
      where: {
        email: normalizeEmail(email),
        purpose,
        identitySubject,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });
  }

  async verify(
    email: string,
    code: string,
    purpose: EmailOtpPurpose,
  ): Promise<{ identitySubject: string | null }> {
    const normalizedEmail = normalizeEmail(email);
    const otp = await this.prisma.emailOtp.findFirst({
      where: {
        email: normalizedEmail,
        purpose,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp) {
      throw new UnauthorizedException(
        'Verification code is invalid or expired',
      );
    }

    if (otp.attempts >= otp.maxAttempts) {
      throw new HttpException(
        'Too many verification attempts; request a new code',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (!safeCompare(otp.codeHash, this.hashCode(code))) {
      const attempts = await this.prisma.emailOtp.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
        select: { attempts: true },
      });

      if (attempts.attempts >= otp.maxAttempts) {
        throw new HttpException(
          'Too many verification attempts; request a new code',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new UnauthorizedException(
        'Verification code is invalid or expired',
      );
    }

    const consumed = await this.prisma.emailOtp.updateMany({
      where: { id: otp.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw new UnauthorizedException(
        'Verification code is invalid or expired',
      );
    }

    return { identitySubject: otp.identitySubject };
  }

  async findIdentitySubject(
    email: string,
    purpose: EmailOtpPurpose,
  ): Promise<string | null> {
    const otp = await this.prisma.emailOtp.findFirst({
      where: {
        email: normalizeEmail(email),
        purpose,
        identitySubject: { not: null },
        expiresAt: { gt: new Date() },
      },
      select: { identitySubject: true },
      orderBy: { createdAt: 'desc' },
    });
    return otp?.identitySubject ?? null;
  }

  private hashCode(code: string): string {
    const pepper = this.config.get<string>('SECRET_AUTH_PEPPER');
    if (!pepper || Buffer.byteLength(pepper, 'utf8') < 32) {
      throw new ServiceUnavailableException(
        'SECRET_AUTH_PEPPER must contain at least 32 bytes',
      );
    }
    return createHmac('sha256', pepper).update(code).digest('hex');
  }
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new ConflictException('A valid email address is required');
  }
  return normalized;
}

function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
