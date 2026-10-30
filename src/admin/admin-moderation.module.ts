import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { AccountModule } from '../account/account.module.js';
import { AdminModerationController } from './admin-moderation.controller.js';
import { AdminModerationService } from './admin-moderation.service.js';
import { AdminOperationsController } from './admin-operations.controller.js';
import { AdminOperationsService } from './admin-operations.service.js';

@Module({
  imports: [PrismaModule, SecretsModule, AccountModule],
  controllers: [AdminModerationController, AdminOperationsController],
  providers: [AdminModerationService, AdminOperationsService],
})
export class AdminModerationModule {}
