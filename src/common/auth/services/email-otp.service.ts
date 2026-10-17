import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.service.js';

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_SECONDS = 60;

@Injectable()
export class EmailOtpService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(email: string, userId?: string): Promise<{ code: string }> {
    const normalizedEmail = normalizeEmail(email);
    const now = new Date();
    const recent = await this.prisma.emailOtp.findFirst({
      where: {
        email: normalizedEmail,
        createdAt: { gte: new Date(now.getTime() - OTP_RESEND_SECONDS * 1000) },
        consumedAt: null,
      },
      select: { id: true },
    });

    if (recent) {
      throw new HttpException(
        'Please wait before requesting another verification code',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await this.prisma.emailOtp.updateMany({
      where: { email: normalizedEmail, consumedAt: null },
      data: { consumedAt: now },
    });

    const code = randomInt(100000, 1000000).toString();
    await this.prisma.emailOtp.create({
      data: {
        email: normalizedEmail,
        userId,
        codeHash: hashCode(code),
        expiresAt: new Date(now.getTime() + OTP_TTL_MINUTES * 60 * 1000),
        maxAttempts: OTP_MAX_ATTEMPTS,
      },
    });

    return { code };
  }

  async verify(email: string, code: string): Promise<void> {
    const normalizedEmail = normalizeEmail(email);
    const otp = await this.prisma.emailOtp.findFirst({
      where: {
        email: normalizedEmail,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp) {
      throw new UnauthorizedException('Verification code is invalid or expired');
    }

    if (otp.attempts >= otp.maxAttempts) {
      throw new HttpException(
        'Too many verification attempts; request a new code',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (!safeCompare(otp.codeHash, hashCode(code))) {
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
      throw new UnauthorizedException('Verification code is invalid or expired');
    }

    await this.prisma.$transaction([
      this.prisma.emailOtp.update({
        where: { id: otp.id },
        data: { consumedAt: new Date() },
      }),
      ...(otp.userId
        ? [
            this.prisma.user.update({
              where: { id: otp.userId },
              data: { emailVerifiedAt: new Date() },
            }),
          ]
        : []),
    ]);
  }
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new ConflictException('A valid email address is required');
  }
  return normalized;
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
