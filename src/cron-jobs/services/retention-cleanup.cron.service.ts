import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class RetentionCleanupCronService {
  private readonly logger = new Logger(RetentionCleanupCronService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupRetainedData(): Promise<void> {
    try {
      const notificationCutoff = new Date(
        Date.now() - 90 * 24 * 60 * 60 * 1000,
      );
      const auditCutoff = new Date(
        Date.now() - 2 * 365 * 24 * 60 * 60 * 1000,
      );
      const [notifications, auditEvents] = await Promise.all([
        this.prisma.notification.deleteMany({
          where: {
            createdAt: { lt: notificationCutoff },
            readAt: { not: null },
          },
        }),
        this.prisma.auditEvent.deleteMany({
          where: {
            timestamp: { lt: auditCutoff },
            secretId: null,
          },
        }),
      ]);
      this.logger.log(
        `Retention cleanup removed ${notifications.count} notifications and ${auditEvents.count} detached audit events`,
      );
    } catch (error: unknown) {
      this.logger.error(
        'Retention cleanup failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
