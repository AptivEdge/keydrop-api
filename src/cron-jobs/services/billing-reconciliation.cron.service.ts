import { Injectable } from '@nestjs/common';
import { BillingService } from '../../billing/billing.service.js';

@Injectable()
export class BillingReconciliationCronService {
  constructor(private readonly billing: BillingService) {}

  async runPastDueSubscriptionReconciliation(): Promise<void> {
    await this.billing.reconcilePastDueSubscriptions();
  }

  async runProviderBillingReconciliation(): Promise<void> {
    await this.billing.reconcileBilling();
  }
}
