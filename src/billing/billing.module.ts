import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { BillingAdminController } from './billing-admin.controller.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { BillingWebhookController } from './billing-webhook.controller.js';

@Module({
  imports: [PrismaModule],
  controllers: [
    BillingController,
    BillingWebhookController,
    BillingAdminController,
  ],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
