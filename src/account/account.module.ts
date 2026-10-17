import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { AccountController } from './account.controller.js';
import { AccountService } from './account.service.js';
import { BillingModule } from '../billing/billing.module.js';

@Module({
  imports: [PrismaModule, StorageModule, BillingModule],
  controllers: [AccountController],
  providers: [AccountService],
  exports: [AccountService],
})
export class AccountModule {}
