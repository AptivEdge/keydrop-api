import { Module, Global } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { CognitoAuthGuard } from './guards/cognito-auth.guard.js';
import { TokenValidationService } from './services/token-validation.service.js';
import { EmailOtpService } from './services/email-otp.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './services/auth.service.js';
import { UsersModule } from '../../users/users.module.js';

@Global()
@Module({
  imports: [ConfigModule, PrismaModule, UsersModule],
  controllers: [AuthController],
  providers: [
    TokenValidationService,
    EmailOtpService,
    AuthService,
    CognitoAuthGuard,
    {
      provide: APP_GUARD,
      useClass: CognitoAuthGuard,
    },
  ],
  exports: [TokenValidationService, CognitoAuthGuard, EmailOtpService],
})
export class AuthModule {}
