import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { SecretsController } from './secrets.controller.js';
import { SecretsService } from './secrets.service.js';
import { RecipientAccessService } from './recipient-access.service.js';
import { TeamsModule } from '../teams/teams.module.js';

@Module({
  imports: [PrismaModule, TeamsModule],
  controllers: [SecretsController],
  providers: [SecretsService, RecipientAccessService],
  exports: [SecretsService],
})
export class SecretsModule {}
