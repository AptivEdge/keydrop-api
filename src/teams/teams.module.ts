import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TeamsController } from './teams.controller.js';
import { TeamsService } from './teams.service.js';
import { EmailDeliveryService } from './email-delivery.service.js';
import { EmailModule } from '../email/email.module.js';

@Module({
  imports: [PrismaModule, EmailModule],
  controllers: [TeamsController],
  providers: [TeamsService, EmailDeliveryService],
  exports: [EmailDeliveryService],
})
export class TeamsModule {}
