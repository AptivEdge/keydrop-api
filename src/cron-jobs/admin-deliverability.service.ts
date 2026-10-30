import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SystemDiagnosticsService } from './system-diagnostics.service.js';

const maxEmailAttempts = 5;

@Injectable()
export class AdminDeliverabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly diagnostics: SystemDiagnosticsService,
  ) {}

  async getDeliverability() {
    const checkedAt = new Date();
    const now = checkedAt;
    const emailDelivery = this.diagnostics.getEmailConfiguration();

    const pendingWhere = {
      emailSentAt: null,
      emailNextAttemptAt: { lte: now },
    };
    const [pending, due, retrying, exhausted, recentRetries] =
      await Promise.all([
        this.prisma.notification.count({
          where: { emailSentAt: null },
        }),
        this.prisma.notification.count({ where: pendingWhere }),
        this.prisma.notification.count({
          where: { emailSentAt: null, emailAttempts: { gt: 0 } },
        }),
        this.prisma.notification.count({
          where: {
            emailSentAt: { not: null },
            emailAttempts: { gte: maxEmailAttempts },
          },
        }),
        this.prisma.notification.findMany({
          where: {
            emailAttempts: { gt: 0 },
            OR: [
              { emailSentAt: null },
              { emailAttempts: { gte: maxEmailAttempts } },
            ],
          },
          select: {
            id: true,
            type: true,
            emailAttempts: true,
            emailSentAt: true,
            emailNextAttemptAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
      ]);

    return {
      checkedAt: checkedAt.toISOString(),
      configuration: {
        ...emailDelivery,
        providerSupported: emailDelivery.provider === 'resend',
      },
      queue: {
        pending,
        due,
        retrying,
        exhausted,
      },
      recentRetries: recentRetries.map((notification) => ({
        id: notification.id,
        type: notification.type,
        attempts: notification.emailAttempts,
        state:
          notification.emailAttempts >= maxEmailAttempts
            ? 'exhausted'
            : 'retrying',
        nextAttemptAt:
          notification.emailSentAt === null
            ? notification.emailNextAttemptAt.toISOString()
            : null,
        createdAt: notification.createdAt.toISOString(),
      })),
      deliveryReceiptsAvailable: false,
      message:
        'Queue and retry state are available. Provider delivery receipts and bounce events are not stored by the current email integration.',
    };
  }
}
