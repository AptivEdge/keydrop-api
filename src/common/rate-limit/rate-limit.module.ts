import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitGuard } from './rate-limit.guard.js';
import { RateLimitService } from './rate-limit.service.js';
import { PrismaModule } from '../../prisma/prisma.module.js';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    RateLimitService,
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
  exports: [RateLimitService],
})
export class RateLimitModule {}
