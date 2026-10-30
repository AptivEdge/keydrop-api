import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class EmailOtpCleanupCronService {
  private readonly logger = new Logger(EmailOtpCleanupCronService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredOtps(): Promise<void> {
    try {
      await this.runExpiredOtpCleanup();
    } catch (error: unknown) {
      this.logger.error(
        'Email OTP cleanup failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async runExpiredOtpCleanup(): Promise<void> {
    const result = await this.prisma.emailOtp.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date() } },
          { createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        ],
      },
    });
    this.logger.log(`Cleaned up ${result.count} expired email OTP records`);
  }
}
