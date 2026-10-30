import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TeamsModule } from '../teams/teams.module.js';
import {
  AccountRequestsController,
  PublicRequestsController,
} from './requests.controller.js';
import { RequestsService } from './requests.service.js';
import { RequestsCleanupCronService } from './requests-cleanup.cron.service.js';

@Module({
  imports: [PrismaModule, TeamsModule],
  controllers: [PublicRequestsController, AccountRequestsController],
  providers: [RequestsService, RequestsCleanupCronService],
  exports: [RequestsService, RequestsCleanupCronService],
})
export class RequestsModule {}
