import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { EMAIL_TEMPLATE_NAMES } from '../email/email-provider.js';
import { PrismaService } from '../prisma/prisma.service.js';

const scheduledJobs = [
  { name: 'secret-cleanup', schedule: 'Every hour' },
  { name: 'storage-deletion-retry', schedule: 'Every 10 minutes' },
  { name: 'email-otp-cleanup', schedule: 'Every hour' },
  { name: 'retention-cleanup', schedule: 'Daily at 03:00' },
  { name: 'notification-generation', schedule: 'Every 10 minutes' },
  { name: 'notification-email-delivery', schedule: 'Every 5 minutes' },
  { name: 'past-due-subscription-reconciliation', schedule: 'Every 30 minutes' },
  { name: 'billing-reconciliation', schedule: 'Every 6 hours' },
  { name: 'request-cleanup', schedule: 'Every hour' },
  { name: 'rate-limit-cleanup', schedule: 'Every hour' },
] as const;

const staleQueueThresholdMs = 30 * 60 * 1000;

@Injectable()
export class SystemDiagnosticsService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @Optional() private readonly scheduler?: SchedulerRegistry,
  ) {}

  async getDiagnostics() {
    const checkedAt = new Date();
    const [backgroundJobs, databaseAndQueues, emailDelivery] = await Promise.all([
      Promise.resolve(this.getBackgroundJobs()),
      this.getDatabaseAndQueues(checkedAt),
      Promise.resolve(this.getEmailConfiguration()),
    ]);

    return {
      checkedAt: checkedAt.toISOString(),
      backgroundJobs,
      database: databaseAndQueues.database,
      queues: databaseAndQueues.queues,
      emailDelivery,
    };
  }

  private getBackgroundJobs() {
    if (this.config.get<string>('VERCEL') === '1') {
      const triggerConfigured = Boolean(
        this.config.get<string>('INTERNAL_JOBS_TOKEN')?.trim(),
      );
      return {
        state: triggerConfigured ? 'configured' : 'unavailable',
        mode: 'external',
        expectedJobs: scheduledJobs.length,
        registeredJobs: null,
        lastRunAt: null,
        nextRunAt: null,
        jobs: scheduledJobs,
        message: triggerConfigured
          ? 'External scheduler mode is configured. The API cannot verify that external triggers are running.'
          : 'External scheduler mode requires INTERNAL_JOBS_TOKEN and external triggers.',
      };
    }

    if (!this.scheduler) {
      return {
        state: 'unavailable',
        mode: 'in-process',
        expectedJobs: scheduledJobs.length,
        registeredJobs: 0,
        lastRunAt: null,
        nextRunAt: null,
        jobs: [],
        message: 'The in-process scheduler is not available.',
      };
    }

    const registered = [...this.scheduler.getCronJobs()].map(([key, job]) => {
      const name = key.split('.').at(-1) ?? key;
      let nextRunAt: string | null = null;
      try {
        nextRunAt = job.nextDate().toISO();
      } catch {
        nextRunAt = null;
      }
      return {
        name,
        running: job.isActive,
        lastRunAt: job.lastDate()?.toISOString() ?? null,
        nextRunAt,
      };
    });
    const state =
      registered.length === scheduledJobs.length &&
      registered.every((job) => job.running && job.nextRunAt)
        ? 'healthy'
        : 'degraded';
    const lastRunAt = registered
      .map((job) => job.lastRunAt)
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null;
    const nextRunAt = registered
      .map((job) => job.nextRunAt)
      .filter((value): value is string => value !== null)
      .sort()[0] ?? null;

    return {
      state,
      mode: 'in-process',
      expectedJobs: scheduledJobs.length,
      registeredJobs: registered.length,
      lastRunAt,
      nextRunAt,
      jobs: registered,
      message:
        state === 'healthy'
          ? 'Scheduled jobs are registered and active in this API process.'
          : 'One or more scheduled jobs are missing, stopped, or have no next run time.',
    };
  }

  private async getDatabaseAndQueues(checkedAt: Date) {
    const startedAt = Date.now();
    let responseTimeMs: number;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      responseTimeMs = Date.now() - startedAt;
    } catch {
      return {
        database: {
          state: 'unavailable',
          responseTimeMs: Date.now() - startedAt,
          message: 'The database health query failed.',
        },
        queues: {
          state: 'unavailable',
          emailNotifications: null,
          storageDeletions: null,
          message: 'Queue metrics are unavailable until the database responds.',
        },
      };
    }

    try {
      const [emailPending, emailDue, oldestEmail, storagePending, storageDue, oldestStorage] =
        await Promise.all([
          this.prisma.notification.count({ where: { emailSentAt: null } }),
          this.prisma.notification.count({
            where: { emailSentAt: null, emailNextAttemptAt: { lte: checkedAt } },
          }),
          this.prisma.notification.findFirst({
            where: { emailSentAt: null },
            select: { createdAt: true },
            orderBy: { createdAt: 'asc' },
          }),
          this.prisma.storageDeletion.count({ where: { deletedAt: null } }),
          this.prisma.storageDeletion.count({
            where: { deletedAt: null, nextRetryAt: { lte: checkedAt } },
          }),
          this.prisma.storageDeletion.findFirst({
            where: { deletedAt: null },
            select: { createdAt: true },
            orderBy: { createdAt: 'asc' },
          }),
        ]);
      const oldestEmailAgeMs = oldestEmail
        ? checkedAt.getTime() - oldestEmail.createdAt.getTime()
        : 0;
      const oldestStorageAgeMs = oldestStorage
        ? checkedAt.getTime() - oldestStorage.createdAt.getTime()
        : 0;
      const stale =
        oldestEmailAgeMs > staleQueueThresholdMs ||
        oldestStorageAgeMs > staleQueueThresholdMs;

      return {
        database: {
          state: 'healthy',
          responseTimeMs,
          message: 'Database query and queue metrics completed.',
        },
        queues: {
          state: stale ? 'degraded' : 'healthy',
          emailNotifications: {
            pending: emailPending,
            due: emailDue,
            oldestPendingAt: oldestEmail?.createdAt.toISOString() ?? null,
          },
          storageDeletions: {
            pending: storagePending,
            due: storageDue,
            oldestPendingAt: oldestStorage?.createdAt.toISOString() ?? null,
          },
          message: stale
            ? 'At least one queue has pending work older than 30 minutes.'
            : 'Queue metrics are current; pending items are included below.',
        },
      };
    } catch {
      return {
        database: {
          state: 'healthy',
          responseTimeMs,
          message: 'Database query succeeded.',
        },
        queues: {
          state: 'unavailable',
          emailNotifications: null,
          storageDeletions: null,
          message: 'Queue metrics are unavailable until the database responds.',
        },
      };
    }
  }

  getEmailConfiguration() {
    const provider = (
      this.config.get<string>('EMAIL_PROVIDER') ?? 'resend'
    ).toLowerCase();
    const apiKeyConfigured = Boolean(
      this.config.get<string>('EMAIL_API_KEY')?.trim(),
    );
    const senderConfigured = Boolean(
      this.config.get<string>('EMAIL_FROM')?.trim(),
    );
    const configuredTemplates = EMAIL_TEMPLATE_NAMES.filter((name) =>
      this.config.get<string>(`EMAIL_TEMPLATE_${name.toUpperCase()}`)?.trim(),
    ).length;
    const ready =
      provider === 'resend' &&
      apiKeyConfigured &&
      senderConfigured &&
      configuredTemplates === EMAIL_TEMPLATE_NAMES.length;

    return {
      state: ready
        ? 'configured'
        : provider === 'resend'
          ? 'degraded'
          : 'unavailable',
      provider,
      apiKeyConfigured,
      senderConfigured,
      configuredTemplates,
      totalTemplates: EMAIL_TEMPLATE_NAMES.length,
      message: ready
        ? 'Provider credentials and all email templates are configured. Live provider delivery is not probed.'
        : provider !== 'resend'
          ? 'The configured email provider is unsupported.'
          : 'Email delivery configuration is incomplete.',
    };
  }
}
