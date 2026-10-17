import {
  ConflictException,
  GoneException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

interface AccessTokenPayload {
  secretId: string;
  recipientEmailHash: string;
  jti: string;
  exp: number;
}

@Injectable()
export class RecipientAccessService {
  private readonly emailClient: SESv2Client;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.emailClient = new SESv2Client({
      region: this.config.get<string>('SES_REGION'),
    });
  }

  async requestAccess(secretId: string, email: string): Promise<{ sent: true }> {
    const normalizedEmail = normalizeEmail(email);
    const secret = await this.prisma.secret.findUnique({
      where: { id: secretId },
      select: {
        id: true,
        status: true,
        expiresAt: true,
        recipientEmailHash: true,
      },
    });
    if (!secret) throw new GoneException('Secret is unavailable');
    if (
      secret.status !== 'active' ||
      (secret.expiresAt && secret.expiresAt <= new Date())
    ) {
      throw new GoneException('Secret is unavailable');
    }
    if (!secret.recipientEmailHash) {
      throw new ConflictException('This secret does not require recipient verification');
    }
    if (!safeCompare(secret.recipientEmailHash, hashEmail(normalizedEmail))) {
      throw new UnauthorizedException('Recipient email is not authorized');
    }

    const token = this.createToken(secret.id, hashEmail(normalizedEmail));
    const from = this.config.get<string>('SES_FROM_EMAIL');
    if (!from) {
      throw new ServiceUnavailableException('SES_FROM_EMAIL is not configured');
    }
    try {
      await this.emailClient.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: [normalizedEmail] },
          Content: {
            Simple: {
              Subject: { Data: 'Your Keydrop secret access link' },
              Body: {
                Text: {
                  Data: [
                    'Use the following access token to reveal the secret:',
                    '',
                    token,
                    '',
                    `This token expires in ${ACCESS_TOKEN_TTL_SECONDS / 60} minutes and must be supplied to the reveal endpoint.`,
                  ].join('\n'),
                },
              },
            },
          },
        }),
      );
    } catch {
      throw new ServiceUnavailableException('Unable to deliver recipient access token');
    }

    await this.prisma.auditEvent.create({
      data: {
        eventType: 'access_granted',
        secretId,
        device: `recipient-token:${token.split('.')[1]}`,
      },
    });
    return { sent: true };
  }

  async verify(secretId: string, token: string): Promise<void> {
    const payload = this.parseToken(token);
    if (payload.secretId !== secretId || payload.exp <= Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('Recipient access token is invalid or expired');
    }
    const secret = await this.prisma.secret.findUnique({
      where: { id: secretId },
      select: { recipientEmailHash: true, status: true, expiresAt: true },
    });
    if (
      !secret ||
      !secret.recipientEmailHash ||
      secret.recipientEmailHash !== payload.recipientEmailHash ||
      secret.status !== 'active' ||
      (secret.expiresAt && secret.expiresAt <= new Date())
    ) {
      throw new UnauthorizedException('Recipient access token is invalid or expired');
    }
  }

  private createToken(secretId: string, recipientEmailHash: string): string {
    const payload: AccessTokenPayload = {
      secretId,
      recipientEmailHash,
      jti: randomBytes(16).toString('hex'),
      exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
    };
    const encodedPayload = encode(payload);
    return `${encodedPayload}.${this.sign(encodedPayload)}`;
  }

  private parseToken(token: string): AccessTokenPayload {
    const [encodedPayload, signature, extra] = token.split('.');
    if (!encodedPayload || !signature || extra) {
      throw new UnauthorizedException('Recipient access token is invalid or expired');
    }
    if (!safeCompare(signature, this.sign(encodedPayload))) {
      throw new UnauthorizedException('Recipient access token is invalid or expired');
    }
    try {
      const payload = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as AccessTokenPayload;
      if (
        typeof payload.secretId !== 'string' ||
        typeof payload.recipientEmailHash !== 'string' ||
        typeof payload.jti !== 'string' ||
        typeof payload.exp !== 'number'
      ) {
        throw new Error('Malformed payload');
      }
      return payload;
    } catch {
      throw new UnauthorizedException('Recipient access token is invalid or expired');
    }
  }

  private sign(value: string): string {
    const secret = this.config.get<string>('RECIPIENT_ACCESS_TOKEN_SECRET');
    if (!secret) {
      throw new ServiceUnavailableException(
        'RECIPIENT_ACCESS_TOKEN_SECRET is not configured',
      );
    }
    return createHmac('sha256', secret).update(value).digest('base64url');
  }
}

function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new ConflictException('A valid email address is required');
  }
  return normalized;
}

function hashEmail(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function encode(value: AccessTokenPayload): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
