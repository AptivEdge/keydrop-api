import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { EmailOtpPurpose } from '../../../generated/prisma/enums.js';
import { UsersService } from '../../../users/controllers/users.service.js';
import { EmailService } from '../../../email/email.service.js';
import {
  EmailOtpCooldownException,
  EmailOtpService,
} from './email-otp.service.js';
import { SupabaseClientProvider } from './supabase-client.provider.js';

export interface AuthTokens {
  accessToken: string;
  idToken: string;
  refreshToken?: string;
  expiresIn: number;
  tokenType: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersService,
    private readonly supabase: SupabaseClientProvider,
    private readonly emailOtp: EmailOtpService,
    private readonly email: EmailService,
  ) {}

  async signUp(email: string, password: string) {
    return this.signUpWithSupabase(email, password);
  }

  async confirmEmail(email: string, code: string) {
    return this.confirmSupabaseEmail(email, code);
  }

  async resendVerification(email: string) {
    return this.resendSupabaseVerification(email);
  }

  async requestPasswordReset(email: string) {
    return this.requestSupabasePasswordReset(email);
  }

  async resetPassword(email: string, code: string, newPassword: string) {
    return this.resetSupabasePassword(email, code, newPassword);
  }

  async login(email: string, password: string): Promise<AuthTokens> {
    return this.loginWithSupabase(email, password);
  }

  async createAdminAccount(email: string, actorId: string) {
    return this.provisionAdminAccount(email, actorId, false);
  }

  async createFirstAdminAccount(email: string, password: string) {
    return this.provisionAdminAccount(email, 'bootstrap', true, password);
  }

  private async provisionAdminAccount(
    email: string,
    actorId: string,
    firstAdmin: boolean,
    initialPassword?: string,
  ) {
    const normalizedEmail = normalizeEmail(email);
    await this.users.assertNotBlocklisted(normalizedEmail);
    let identitySubject: string | undefined;
    let profileCreated = false;

    try {
      const password = initialPassword ?? randomBytes(32).toString('hex');
      const { data, error } = await this.supabase
        .getAdminClient()
        .auth.admin.createUser({
          email: normalizedEmail,
          password,
          email_confirm: false,
        });
      if (error) throw error;
      if (!data.user?.id) {
        throw new ServiceUnavailableException(
          'Supabase did not return the expected admin identity',
        );
      }
      identitySubject = data.user.id;
      if (data.user.email?.trim().toLowerCase() !== normalizedEmail) {
        throw new ServiceUnavailableException(
          'Supabase did not return the expected admin identity',
        );
      }
      const profile = firstAdmin
        ? await this.users.createFirstAdminIdentity(
            identitySubject,
            normalizedEmail,
          )
        : await this.users.createAdminIdentity(
            identitySubject,
            normalizedEmail,
          );
      profileCreated = true;

      const { code } = await this.emailOtp.issue(
        normalizedEmail,
        EmailOtpPurpose.email_verification,
        identitySubject,
      );
      await this.sendAuthCode(
        normalizedEmail,
        code,
        EmailOtpPurpose.email_verification,
      );
      this.logger.log(
        JSON.stringify({
          event: firstAdmin
            ? 'first_admin_bootstrapped'
            : 'admin_account_provisioned',
          actorId,
          targetUserId: profile.id,
        }),
      );

      return {
        id: profile.id,
        email: normalizedEmail,
        role: 'ADM' as const,
        emailVerificationRequired: true,
        passwordSetupRequired: !initialPassword,
      };
    } catch (error) {
      this.logAuthFailure('admin_account_provision', error);
      if (identitySubject) {
        let cleanupSucceeded = true;
        try {
          await this.emailOtp.cancel(
            normalizedEmail,
            EmailOtpPurpose.email_verification,
            identitySubject,
          );
        } catch (cleanupError) {
          cleanupSucceeded = false;
          this.logCleanupFailure('admin_provision_otp', cleanupError);
        }
        if (profileCreated) {
          try {
            await this.users.removeProvisionedAdmin(identitySubject);
          } catch (cleanupError) {
            cleanupSucceeded = false;
            this.logCleanupFailure('admin_provision_profile', cleanupError);
          }
        }
        try {
          const { error: deleteError } = await this.supabase
            .getAdminClient()
            .auth.admin.deleteUser(identitySubject);
          if (deleteError) throw deleteError;
        } catch (cleanupError) {
          cleanupSucceeded = false;
          this.logCleanupFailure('admin_provision_identity', cleanupError);
        }
        if (!cleanupSucceeded) {
          throw new ServiceUnavailableException(
            'Admin account creation failed and cleanup was incomplete; contact support',
          );
        }
      }
      throw this.mapSupabaseError(error);
    }
  }

  async completeGithubOAuth(accessToken: string) {
    try {
      const { data, error } =
        await this.getSupabaseClient().auth.getUser(accessToken);
      if (error) throw error;

      const identity = data.user;
      const providers = identity?.app_metadata.providers;
      const isGithubIdentity =
        identity?.app_metadata.provider === 'github' ||
        (Array.isArray(providers) && providers.includes('github'));
      if (
        !identity ||
        !isGithubIdentity ||
        !identity.email ||
        !identity.email_confirmed_at
      ) {
        throw new UnauthorizedException(
          'A verified GitHub account is required',
        );
      }

      const profile = await this.users.upsertCustomerFromOAuth(
        identity.id,
        identity.email,
      );
      if (profile.suspendedAt) {
        throw new ForbiddenException('This account is suspended');
      }
      return { authenticated: true };
    } catch (error) {
      throw this.mapSupabaseError(error);
    }
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    return this.refreshSupabaseSession(refreshToken);
  }

  async logout(accessToken: string): Promise<void> {
    return this.logoutSupabaseSession(accessToken);
  }

  private getSupabaseClient() {
    return this.supabase.getPublicClient();
  }

  private async signUpWithSupabase(email: string, password: string) {
    const normalizedEmail = normalizeEmail(email);
    await this.users.assertNotBlocklisted(normalizedEmail);
    let createdIdentitySubject: string | undefined;
    try {
      const { data, error } = await this.supabase
        .getAdminClient()
        .auth.admin.createUser({
          email: normalizedEmail,
          password,
          email_confirm: false,
        });
      if (error) throw error;
      createdIdentitySubject = data.user?.id;
      if (!data.user?.id || !data.user.email) {
        throw new ServiceUnavailableException(
          'Supabase did not return a registered user',
        );
      }
      const { code } = await this.emailOtp.issue(
        normalizedEmail,
        EmailOtpPurpose.email_verification,
        data.user.id,
      );
      await this.sendAuthCode(
        normalizedEmail,
        code,
        EmailOtpPurpose.email_verification,
      );
      return {
        userSub: data.user.id,
        email: normalizedEmail,
        emailConfirmed: false,
        nextStep: 'confirm_email',
      };
    } catch (error) {
      this.logAuthFailure('signup', error);
      if (createdIdentitySubject) {
        const cleanedUp = await this.cleanupFailedSignup(
          normalizedEmail,
          createdIdentitySubject,
        );
        if (!cleanedUp) {
          throw new ServiceUnavailableException(
            'Signup failed and cleanup of the unverified account was incomplete; contact support',
          );
        }
      }
      throw this.mapSupabaseError(error);
    }
  }

  private async cleanupFailedSignup(
    email: string,
    identitySubject: string,
  ): Promise<boolean> {
    let cleanupSucceeded = true;
    try {
      await this.emailOtp.cancel(
        email,
        EmailOtpPurpose.email_verification,
        identitySubject,
      );
    } catch (error) {
      cleanupSucceeded = false;
      this.logCleanupFailure('signup_otp', error);
    }

    try {
      const { error } = await this.supabase
        .getAdminClient()
        .auth.admin.deleteUser(identitySubject);
      if (error) throw error;
    } catch (error) {
      cleanupSucceeded = false;
      this.logCleanupFailure('signup_identity', error);
    }

    return cleanupSucceeded;
  }

  private logCleanupFailure(operation: string, error: unknown): void {
    const errorType = error instanceof Error ? error.name : typeof error;
    this.logger.error(
      JSON.stringify({
        event: 'auth_cleanup_failure',
        operation,
        errorType,
      }),
    );
  }

  private async confirmSupabaseEmail(email: string, code: string) {
    const normalizedEmail = normalizeEmail(email);
    try {
      const verifiedOtp = await this.emailOtp.verify(
        normalizedEmail,
        code,
        EmailOtpPurpose.email_verification,
      );
      if (!verifiedOtp.identitySubject) {
        throw new UnauthorizedException(
          'Verification code is invalid or expired',
        );
      }
      const { data: identity, error: lookupError } = await this.supabase
        .getAdminClient()
        .auth.admin.getUserById(verifiedOtp.identitySubject);
      if (lookupError) throw lookupError;
      if (
        !identity.user?.email ||
        identity.user.email.trim().toLowerCase() !== normalizedEmail
      ) {
        throw new UnauthorizedException(
          'Verification code is invalid or expired',
        );
      }
      const { data, error } = await this.supabase
        .getAdminClient()
        .auth.admin.updateUserById(verifiedOtp.identitySubject, {
          email_confirm: true,
        });
      if (error) throw error;
      if (!data.user?.id || !data.user.email) {
        throw new UnauthorizedException(
          'Verification code is invalid or expired',
        );
      }
      if (data.user.email.trim().toLowerCase() !== normalizedEmail) {
        throw new UnauthorizedException(
          'Verification code is invalid or expired',
        );
      }
      await this.users.upsertFromIdentity(data.user.id, data.user.email, true);
      return { email: normalizedEmail, emailVerified: true };
    } catch (error) {
      throw this.mapSupabaseError(error);
    }
  }

  private async resendSupabaseVerification(email: string) {
    const normalizedEmail = normalizeEmail(email);
    try {
      const user = await this.findSupabaseUser(normalizedEmail);
      if (!user || user.email_confirmed_at) {
        return { email: normalizedEmail, sent: true };
      }

      const { code } = await this.emailOtp.issue(
        normalizedEmail,
        EmailOtpPurpose.email_verification,
        user.id,
      );
      await this.sendAuthCode(
        normalizedEmail,
        code,
        EmailOtpPurpose.email_verification,
      );
      return { email: normalizedEmail, sent: true };
    } catch (error) {
      if (error instanceof EmailOtpCooldownException) {
        return { email: normalizedEmail, sent: true };
      }
      throw this.mapSupabaseError(error);
    }
  }

  private async requestSupabasePasswordReset(email: string) {
    const normalizedEmail = normalizeEmail(email);
    try {
      const user = await this.findSupabaseUser(normalizedEmail);
      if (!user?.email_confirmed_at) {
        return { email: normalizedEmail, sent: true };
      }

      const { code } = await this.emailOtp.issue(
        normalizedEmail,
        EmailOtpPurpose.password_reset,
        user.id,
      );
      await this.sendAuthCode(
        normalizedEmail,
        code,
        EmailOtpPurpose.password_reset,
      );
      return { email: normalizedEmail, sent: true };
    } catch (error) {
      if (error instanceof EmailOtpCooldownException) {
        return { email: normalizedEmail, sent: true };
      }
      throw this.mapSupabaseError(error);
    }
  }

  private async resetSupabasePassword(
    email: string,
    code: string,
    newPassword: string,
  ) {
    try {
      const verifiedOtp = await this.emailOtp.verify(
        email,
        code,
        EmailOtpPurpose.password_reset,
      );
      if (!verifiedOtp.identitySubject) {
        throw new UnauthorizedException(
          'Password reset code is invalid or expired',
        );
      }
      const { error } = await this.supabase
        .getAdminClient()
        .auth.admin.updateUserById(verifiedOtp.identitySubject, {
          password: newPassword,
        });
      if (error) throw error;
      return { email: normalizeEmail(email), passwordReset: true };
    } catch (error) {
      throw this.mapSupabaseError(error);
    }
  }

  private async loginWithSupabase(
    email: string,
    password: string,
  ): Promise<AuthTokens> {
    const normalizedEmail = normalizeEmail(email);
    await this.users.assertNotBlocklisted(normalizedEmail);
    try {
      const { data, error } =
        await this.getSupabaseClient().auth.signInWithPassword({
          email: normalizedEmail,
          password,
        });
      if (error) throw error;
      if (!data.session || !data.user.email) {
        throw new ConflictException('Email verification is required');
      }
      const profile = await this.users.upsertFromIdentity(
        data.user.id,
        data.user.email,
        Boolean(data.user.email_confirmed_at),
      );
      if (profile.suspendedAt) {
        throw new ForbiddenException('This account is suspended');
      }
      return this.mapSupabaseTokens(data.session);
    } catch (error) {
      this.logAuthFailure('login', error);
      throw this.mapSupabaseError(error);
    }
  }

  private async refreshSupabaseSession(
    refreshToken: string,
  ): Promise<AuthTokens> {
    try {
      const { data, error } =
        await this.getSupabaseClient().auth.refreshSession({
          refresh_token: refreshToken,
        });
      if (error) throw error;
      if (!data.session) {
        throw new UnauthorizedException('Refresh token is invalid');
      }
      return this.mapSupabaseTokens(data.session);
    } catch (error) {
      throw this.mapSupabaseError(error);
    }
  }

  private async logoutSupabaseSession(accessToken: string): Promise<void> {
    try {
      const { error } = await this.supabase
        .getAdminClient()
        .auth.admin.signOut(accessToken, 'global');
      if (error) throw error;
    } catch (error) {
      throw this.mapSupabaseError(error);
    }
  }

  private mapSupabaseTokens(
    session: {
      access_token: string;
      refresh_token: string;
      expires_in?: number;
      token_type?: string;
    },
  ): AuthTokens {
    return {
      accessToken: session.access_token,
      idToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresIn: session.expires_in ?? 3600,
      tokenType: session.token_type ?? 'Bearer',
    };
  }

  private mapSupabaseError(error: unknown): Error {
    if (error instanceof HttpException) return error;

    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : '';
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? Number(error.status)
        : undefined;
    const message = error instanceof Error ? error.message.toLowerCase() : '';

    if (code === 'user_already_exists' || code === 'email_exists') {
      return new ConflictException('An account with this email already exists');
    }
    if (code === 'weak_password' || message.includes('password should')) {
      return new BadRequestException(
        'Password does not meet the password policy',
      );
    }
    if (
      code.includes('otp') ||
      code === 'invalid_credentials' ||
      message.includes('invalid login credentials')
    ) {
      return new UnauthorizedException('Email or verification code is invalid');
    }
    if (code === 'bad_jwt' || code === 'invalid_token' || status === 401) {
      return new UnauthorizedException('Supabase session is invalid');
    }
    if (status === 429) {
      return new HttpException(
        'Supabase Auth rate limit was reached; retry later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return new ServiceUnavailableException(
      'Supabase authentication request failed',
    );
  }

  private async findSupabaseUser(email: string) {
    const admin = this.supabase.getAdminClient().auth.admin;
    const identitySubject =
      (await this.users.findIdentitySubjectByEmail(email)) ??
      (await this.emailOtp.findIdentitySubject(
        email,
        EmailOtpPurpose.email_verification,
      ));
    if (identitySubject) {
      const { data, error } = await admin.getUserById(identitySubject);
      if (error) throw error;
      if (data.user?.email?.toLowerCase() === email) return data.user;
    }

    for (let page = 1; page <= 100; page += 1) {
      const { data, error } = await admin.listUsers({ page, perPage: 1000 });
      if (error) throw error;
      const user = data.users.find(
        (candidate) => candidate.email?.toLowerCase() === email,
      );
      if (user) return user;
      if (data.nextPage === null || data.nextPage === undefined) return null;
    }
    throw new ServiceUnavailableException(
      'Unable to locate the Supabase identity; user listing limit reached',
    );
  }

  private sendAuthCode(
    email: string,
    code: string,
    purpose: EmailOtpPurpose,
  ): Promise<void> {
    const verification = purpose === EmailOtpPurpose.email_verification;
    return this.email.send({
      to: email,
      template: verification ? 'auth_verification' : 'password_reset',
      variables: { CODE: code, EXPIRY_MINUTES: 10 },
    });
  }

  private logAuthFailure(operation: string, error: unknown): void {
    const errorType = error instanceof Error ? error.name : typeof error;
    const errorCode =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.code)
        ? error.code
        : undefined;
    const statusCode =
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      typeof error.status === 'number' &&
      Number.isInteger(error.status) &&
      error.status >= 400 &&
      error.status <= 599
        ? error.status
        : undefined;

    this.logger.warn(
      JSON.stringify({
        event: 'auth_operation_failure',
        operation,
        errorType,
        ...(errorCode ? { errorCode } : {}),
        ...(statusCode ? { statusCode } : {}),
      }),
    );
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
