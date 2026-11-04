import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class EmailOtpCleanupCronService {
  private readonly logger = new Logger(EmailOtpCleanupCronService.name);

  constructor(private readonly prisma: PrismaService) {}

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
