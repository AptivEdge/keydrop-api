import {
  MiddlewareConsumer,
  Module,
  NestModule,
  OnApplicationShutdown,
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
import { RequestsModule } from './requests/requests.module.js';
import { LoggerMiddleware } from './logger/middleware/logger.middleware.js';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './logger/filters/http-exception.filter.js';
import { LoggerService } from './logger/services/logger.service.js';
import { LoggerModule } from './logger/logger.module.js';
import { RateLimitModule } from './common/rate-limit/rate-limit.module.js';
import { EmailModule } from './email/email.module.js';
import { AdminModerationModule } from './admin/admin-moderation.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath:
        process.env.NODE_ENV === 'production' ? '.env' : ['.env.local', '.env'],
    }),
    PrismaModule,
    LoggerModule,
    EmailModule,
    AuthModule,
    SecretsModule,
    RequestsModule,
    CronJobsModule.register(),
    UsersModule,
    AccountModule,
    BillingModule,
    TeamsModule,
    RateLimitModule,
    AdminModerationModule,
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
export class AppModule implements NestModule, OnApplicationShutdown {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(LoggerMiddleware)
      .forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }

  async onApplicationShutdown(signal?: string) {
    // Cleanup logic here if needed
    console.log(`Application is shutting down due to signal: ${signal}`);
  }
}
