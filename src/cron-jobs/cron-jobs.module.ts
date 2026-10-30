import { DynamicModule, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../prisma/prisma.module';
import { SecretCleanupCronService } from './services/secret-cleanup.cron.service';
import { EmailOtpCleanupCronService } from './services/email-otp-cleanup.cron.service';
import { RetentionCleanupCronService } from './services/retention-cleanup.cron.service';
import { LoggerModule } from '@keydrop/logger/logger.module';
import { StorageModule } from '../storage/storage.module';
import { TeamsModule } from '../teams/teams.module.js';
import { NotificationsCronService } from './services/notifications.cron.service.js';
import { BillingModule } from '../billing/billing.module.js';
import { BillingReconciliationCronService } from './services/billing-reconciliation.cron.service.js';
import { InternalJobsController } from './internal-jobs.controller.js';
import { RequestsModule } from '../requests/requests.module.js';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module.js';
import { RateLimitCleanupCronService } from './services/rate-limit-cleanup.cron.service.js';
import { AdminSystemDiagnosticsController } from './admin-system-diagnostics.controller.js';
import { SystemDiagnosticsService } from './system-diagnostics.service.js';
import { AdminDeliverabilityController } from './admin-deliverability.controller.js';
import { AdminDeliverabilityService } from './admin-deliverability.service.js';

@Module({})
export class CronJobsModule {
  static register(): DynamicModule {
    const serverless = process.env.VERCEL === '1';
    return {
      module: CronJobsModule,
      imports: [
        ...(serverless ? [] : [ScheduleModule.forRoot()]),
        PrismaModule,
        LoggerModule,
        StorageModule,
        TeamsModule,
        BillingModule,
        RequestsModule,
        RateLimitModule,
      ],
      controllers: [
        InternalJobsController,
        AdminSystemDiagnosticsController,
        AdminDeliverabilityController,
      ],
      providers: [
        SecretCleanupCronService,
        EmailOtpCleanupCronService,
        RetentionCleanupCronService,
        NotificationsCronService,
        BillingReconciliationCronService,
        RateLimitCleanupCronService,
        SystemDiagnosticsService,
        AdminDeliverabilityService,
      ],
      exports: [
        SecretCleanupCronService,
        EmailOtpCleanupCronService,
        RetentionCleanupCronService,
        NotificationsCronService,
        BillingReconciliationCronService,
        RateLimitCleanupCronService,
      ],
    };
  }
}
