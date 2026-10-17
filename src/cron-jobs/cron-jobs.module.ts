import { Module } from '@nestjs/common';
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

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
    LoggerModule,
    StorageModule,
    TeamsModule,
    BillingModule,
  ],
  providers: [
    SecretCleanupCronService,
    EmailOtpCleanupCronService,
    RetentionCleanupCronService,
    NotificationsCronService,
    BillingReconciliationCronService,
  ],
  exports: [
    SecretCleanupCronService,
    EmailOtpCleanupCronService,
    RetentionCleanupCronService,
    NotificationsCronService,
    BillingReconciliationCronService,
  ],
})
export class CronJobsModule {}
