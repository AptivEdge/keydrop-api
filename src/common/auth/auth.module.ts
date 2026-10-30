import { Module, Global } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { SupabaseAuthGuard } from './guards/supabase-auth.guard.js';
import { TokenValidationService } from './services/token-validation.service.js';
import { EmailOtpService } from './services/email-otp.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './services/auth.service.js';
import { UsersModule } from '../../users/users.module.js';
import { SupabaseClientProvider } from './services/supabase-client.provider.js';
import { AdminAccountsController } from './admin-accounts.controller.js';
import { AdminBootstrapController } from './admin-bootstrap.controller.js';

@Global()
@Module({
  imports: [ConfigModule, PrismaModule, UsersModule],
  controllers: [
    AuthController,
    AdminAccountsController,
    AdminBootstrapController,
  ],
  providers: [
    TokenValidationService,
    EmailOtpService,
    SupabaseClientProvider,
    AuthService,
    SupabaseAuthGuard,
    {
      provide: APP_GUARD,
      useClass: SupabaseAuthGuard,
    },
  ],
  exports: [
    TokenValidationService,
    SupabaseAuthGuard,
    EmailOtpService,
    SupabaseClientProvider,
  ],
})
export class AuthModule {}
