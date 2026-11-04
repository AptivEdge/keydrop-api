import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class RetentionCleanupCronService {
  private readonly logger = new Logger(RetentionCleanupCronService.name);

  constructor(private readonly prisma: PrismaService) {}

  async runRetainedDataCleanup(): Promise<void> {
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
  }
}
