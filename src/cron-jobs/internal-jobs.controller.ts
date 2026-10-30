import {
  Controller,
  Headers,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { Public } from '../common/auth/decorators/public.decorator.js';
import { RateLimitCleanupCronService } from './services/rate-limit-cleanup.cron.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RequestsCleanupCronService } from '../requests/requests-cleanup.cron.service.js';
import { BillingReconciliationCronService } from './services/billing-reconciliation.cron.service.js';
import { EmailOtpCleanupCronService } from './services/email-otp-cleanup.cron.service.js';
import { NotificationsCronService } from './services/notifications.cron.service.js';
import { RetentionCleanupCronService } from './services/retention-cleanup.cron.service.js';
import { SecretCleanupCronService } from './services/secret-cleanup.cron.service.js';

const JOB_NAMES = [
  'secret-cleanup',
  'storage-deletion-retry',
  'email-otp-cleanup',
  'retention-cleanup',
  'notification-generation',
  'notification-email-delivery',
  'past-due-subscription-reconciliation',
  'billing-reconciliation',
  'request-cleanup',
  'rate-limit-cleanup',
] as const;

type JobName = (typeof JOB_NAMES)[number];

function isJobName(value: string): value is JobName {
  return JOB_NAMES.some((jobName) => jobName === value);
}

@Public()
@Controller('internal/jobs')
export class InternalJobsController {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly secretCleanup: SecretCleanupCronService,
    private readonly emailOtpCleanup: EmailOtpCleanupCronService,
    private readonly retentionCleanup: RetentionCleanupCronService,
    private readonly notifications: NotificationsCronService,
    private readonly billingReconciliation: BillingReconciliationCronService,
    private readonly requestsCleanup: RequestsCleanupCronService,
    private readonly rateLimitCleanup: RateLimitCleanupCronService,
  ) {}

  @Post(':job')
  async run(
    @Param('job') job: string,
    @Headers('authorization') authorization?: string,
  ): Promise<{ job: JobName; status: 'completed' | 'already_running' }> {
    this.authorize(authorization);
    if (!isJobName(job)) {
      throw new NotFoundException('Scheduled job not found');
    }

    const handlers: Record<JobName, () => Promise<void>> = {
      'secret-cleanup': () => this.secretCleanup.runExpiredSecretCleanup(),
      'storage-deletion-retry': () =>
        this.secretCleanup.runStorageDeletionRetry(),
      'email-otp-cleanup': () => this.emailOtpCleanup.runExpiredOtpCleanup(),
      'retention-cleanup': () => this.retentionCleanup.runRetainedDataCleanup(),
      'notification-generation': () =>
        this.notifications.createSecretExpiryNotifications(),
      'notification-email-delivery': () =>
        this.notifications.deliverPendingNotificationEmails(),
      'past-due-subscription-reconciliation': () =>
        this.billingReconciliation.runPastDueSubscriptionReconciliation(),
      'billing-reconciliation': () =>
        this.billingReconciliation.runProviderBillingReconciliation(),
      'request-cleanup': () => this.requestsCleanup.runExpiredRequestCleanup(),
      'rate-limit-cleanup': () =>
        this.rateLimitCleanup.runExpiredBucketCleanup(),
    };

    const completed = await this.prisma.$transaction(
      async (transaction) => {
        const [lock] = await transaction.$queryRaw<
          Array<{ acquired: boolean }>
        >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`keydrop:scheduled-job:${job}`}, 0)) AS acquired`;
        if (!lock?.acquired) {
          return false;
        }
        await handlers[job]();
        return true;
      },
      { maxWait: 5_000, timeout: 25_000 },
    );

    return {
      job,
      status: completed ? 'completed' : 'already_running',
    };
  }

  private authorize(authorization?: string): void {
    const expectedToken = this.config.get<string>('INTERNAL_JOBS_TOKEN');
    if (!expectedToken) {
      throw new ServiceUnavailableException(
        'Internal job authentication is not configured',
      );
    }

    if (!authorization) {
      throw new UnauthorizedException(
        'Invalid internal job credentials format',
      );
    }

    const expected = expectedToken.trim();
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    const supplied = match?.[1]?.trim();

    if (
      !supplied ||
      supplied.length !== expected.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      throw new UnauthorizedException('Invalid internal job credentials token');
    }
  }
}
