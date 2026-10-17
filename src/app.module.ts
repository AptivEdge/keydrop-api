import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { AppController } from './app.controller.js';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './common/auth/auth.module.js';
import { CronJobsModule } from './cron-jobs/cron-jobs.module.js';
import { UsersModule } from './users/users.module.js';
import { AccountModule } from './account/account.module.js';
import { BillingModule } from './billing/billing.module.js';
import { TeamsModule } from './teams/teams.module.js';
import { SecretsModule } from './secrets/secrets.module.js';
import { LoggerMiddleware } from './logger/middleware/logger.middleware.js';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './logger/filters/http-exception.filter.js';
import { LoggerService } from './logger/services/logger.service.js';
import { LoggerModule } from './logger/logger.module.js';
import { RateLimitModule } from './common/rate-limit/rate-limit.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    LoggerModule,
    AuthModule,
    SecretsModule,
    CronJobsModule,
    UsersModule,
    AccountModule,
    BillingModule,
    TeamsModule,
    RateLimitModule,
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_FILTER,
      useFactory: (loggerService: LoggerService) => {
        return new AllExceptionsFilter(loggerService);
      },
      inject: [LoggerService],
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(LoggerMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
