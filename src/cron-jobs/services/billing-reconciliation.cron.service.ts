import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BillingService } from '../../billing/billing.service.js';

@Injectable()
export class BillingReconciliationCronService {
  private readonly logger = new Logger(BillingReconciliationCronService.name);

  constructor(private readonly billing: BillingService) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async expirePastDueSubscriptions(): Promise<void> {
    try {
      await this.runPastDueSubscriptionReconciliation();
    } catch (error) {
      this.logger.error(
        'Past-due subscription processing failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async runPastDueSubscriptionReconciliation(): Promise<void> {
    await this.billing.reconcilePastDueSubscriptions();
  }

  @Cron(CronExpression.EVERY_6_HOURS)
  async reconcileProviderBilling(): Promise<void> {
    try {
      await this.runProviderBillingReconciliation();
    } catch (error) {
      this.logger.error(
        'Billing reconciliation failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async runProviderBillingReconciliation(): Promise<void> {
    await this.billing.reconcileBilling();
  }
}
