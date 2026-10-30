import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';
import { normalizeNotificationPreferences } from '../../common/notifications/notification-preferences.js';
import { EmailDeliveryService } from '../../teams/email-delivery.service.js';

@Injectable()
export class NotificationsCronService {
  private readonly logger = new Logger(NotificationsCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailDeliveryService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async createSecretExpiryNotifications(): Promise<void> {
    const now = new Date();
    const expiringBefore = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const secrets = await this.prisma.secret.findMany({
      where: {
        ownerId: { not: null },
        status: { in: ['active', 'partially_viewed'] },
        expiresAt: { gt: now, lte: expiringBefore },
        notifications: { none: { type: 'secret_expiring' } },
      },
      select: {
        id: true,
        label: true,
        expiresAt: true,
        owner: {
          select: {
            id: true,
            notificationPreferences: true,
          },
        },
      },
      take: 500,
      orderBy: { expiresAt: 'asc' },
    });

    for (const secret of secrets) {
      if (!secret.owner) continue;
      const preference = normalizeNotificationPreferences(
        secret.owner.notificationPreferences,
      ).secret_expiring;
      await this.prisma.notification.createMany({
        data: [
          {
            userId: secret.owner.id,
            secretId: secret.id,
            type: 'secret_expiring',
            payload: {
              label: secret.label,
              expiresAt: secret.expiresAt?.toISOString(),
            },
            dedupeKey: `secret_expiring:${secret.id}`,
            emailSentAt: preference.email ? null : now,
          },
        ],
        skipDuplicates: true,
      });
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async deliverPendingNotificationEmails(): Promise<void> {
    const notifications = await this.prisma.notification.findMany({
      where: { emailSentAt: null, emailNextAttemptAt: { lte: new Date() } },
      select: {
        id: true,
        type: true,
        emailAttempts: true,
        user: {
          select: {
            email: true,
            notificationPreferences: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    for (const notification of notifications) {
      const preference = normalizeNotificationPreferences(
        notification.user.notificationPreferences,
      )[notification.type];
      if (!preference.email) {
        await this.prisma.notification.updateMany({
          where: { id: notification.id, emailSentAt: null },
          data: { emailSentAt: new Date() },
        });
        continue;
      }
      try {
        await this.email.sendNotificationEmail(
          notification.user.email,
          notification.type,
        );
        await this.prisma.notification.updateMany({
          where: { id: notification.id, emailSentAt: null },
          data: { emailSentAt: new Date() },
        });
      } catch (error) {
        const attempts = notification.emailAttempts + 1;
        const now = new Date();
        const exhausted = attempts >= 5;
        this.logger.error(
          `Notification email delivery failed for ${notification.id} (attempt ${attempts}${exhausted ? ', retries exhausted' : ''})`,
          error instanceof Error ? error.stack : String(error),
        );
        await this.prisma.notification.updateMany({
          where: { id: notification.id, emailSentAt: null },
          data: {
            emailAttempts: attempts,
            emailNextAttemptAt: new Date(
              now.getTime() +
                Math.min(2 ** attempts * 60_000, 24 * 60 * 60 * 1000),
            ),
            ...(exhausted ? { emailSentAt: now } : {}),
          },
        });
      }
    }
  }
}
