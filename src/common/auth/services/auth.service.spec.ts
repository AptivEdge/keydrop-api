import { ConflictException, Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailOtpPurpose } from '../../../generated/prisma/enums.js';
import { EmailOtpCooldownException } from './email-otp.service.js';
import { AuthService } from './auth.service.js';

function createAuthService() {
  const user = {
    id: 'supabase-user-id',
    email: 'user@example.com',
    email_confirmed_at: null as string | null,
  };
  const admin = {
    createUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
    deleteUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
    updateUserById: vi.fn().mockResolvedValue({ data: { user }, error: null }),
    listUsers: vi.fn().mockResolvedValue({
      data: { users: [user], nextPage: null },
      error: null,
    }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
    getUserById: vi.fn().mockResolvedValue({
      data: { user },
      error: null,
    }),
  };
  const publicAuth = {
    signUp: vi.fn(),
    resend: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    verifyOtp: vi.fn(),
    updateUser: vi.fn(),
    signInWithPassword: vi.fn().mockResolvedValue({
      data: {
        user: { ...user, email_confirmed_at: '2026-10-23T00:00:00.000Z' },
        session: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          token_type: 'bearer',
        },
      },
      error: null,
    }),
    refreshSession: vi.fn(),
    getUser: vi.fn().mockResolvedValue({
      data: {
        user: {
          id: 'github-user-id',
          email: 'github@example.com',
          email_confirmed_at: '2026-10-25T00:00:00.000Z',
          app_metadata: { provider: 'github', providers: ['github'] },
        },
      },
      error: null,
    }),
  };
  const users = {
    assertNotBlocklisted: vi.fn().mockResolvedValue(undefined),
    upsertFromIdentity: vi.fn().mockResolvedValue({ suspendedAt: null }),
    findIdentitySubjectByEmail: vi.fn().mockResolvedValue(null),
    upsertCustomerFromOAuth: vi.fn().mockResolvedValue({
      id: 'customer-user-id',
      email: 'github@example.com',
      adminUser: null,
      suspendedAt: null,
    }),
    createAdminIdentity: vi.fn().mockResolvedValue({
      id: 'admin-user-id',
      email: 'user@example.com',
      identitySubject: user.id,
      adminUser: { role: 'ADM' },
    }),
    createFirstAdminIdentity: vi.fn().mockResolvedValue({
      id: 'admin-user-id',
      email: 'admin@example.com',
      identitySubject: user.id,
      adminUser: { role: 'ADM' },
    }),
    removeProvisionedAdmin: vi.fn().mockResolvedValue(undefined),
  };
  const emailOtp = {
    issue: vi.fn().mockResolvedValue({ code: '123456' }),
    cancel: vi.fn().mockResolvedValue(undefined),
    verify: vi.fn().mockResolvedValue({ identitySubject: user.id }),
    findIdentitySubject: vi.fn().mockResolvedValue(null),
  };
  const email = { send: vi.fn().mockResolvedValue(undefined) };
  const supabase = {
    getAdminClient: () => ({ auth: { admin } }),
    getPublicClient: () => ({ auth: publicAuth }),
  };
  const service = new AuthService(
    users as never,
    supabase as never,
    emailOtp as never,
    email as never,
  );

  return { service, user, admin, publicAuth, users, emailOtp, email };
}

describe('AuthService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates identities without Supabase email and delivers verification through Resend', async () => {
    const { service, admin, publicAuth, emailOtp, email } = createAuthService();

    await expect(
      service.signUp(' USER@example.com ', 'valid-password'),
    ).resolves.toEqual({
      userSub: 'supabase-user-id',
      email: 'user@example.com',
      emailConfirmed: false,
      nextStep: 'confirm_email',
    });

    expect(admin.createUser).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: 'valid-password',
      email_confirm: false,
    });
    expect(publicAuth.signUp).not.toHaveBeenCalled();
    expect(emailOtp.issue).toHaveBeenCalledWith(
      'user@example.com',
      EmailOtpPurpose.email_verification,
      'supabase-user-id',
    );
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        template: 'auth_verification',
        variables: { CODE: '123456', EXPIRY_MINUTES: 10 },
      }),
    );
  });

  it('creates an invited ADM with a random password and emails verification', async () => {
    const { service, admin, users, emailOtp, email } = createAuthService();
    admin.createUser.mockResolvedValue({
      data: { user: { id: 'supabase-user-id', email: 'admin@example.com' } },
      error: null,
    });

    const result = await service.createAdminAccount(
      ' ADMIN@example.com ',
      'creator-id',
    );
    expect(result).toEqual({
      id: 'admin-user-id',
      email: 'admin@example.com',
      role: 'ADM',
      emailVerificationRequired: true,
      passwordSetupRequired: true,
    });
    expect(result).not.toHaveProperty('passwordSetupToken');

    const [credentials] = admin.createUser.mock.calls[0] as [
      { email: string; password: string; email_confirm: boolean },
    ];
    expect(credentials).toMatchObject({
      email: 'admin@example.com',
      email_confirm: false,
    });
    expect(credentials.password).toHaveLength(64);
    expect(credentials.password).not.toBe('valid-password');
    expect(users.createAdminIdentity).toHaveBeenCalledWith(
      'supabase-user-id',
      'admin@example.com',
    );
    expect(emailOtp.issue).toHaveBeenCalledWith(
      'admin@example.com',
      EmailOtpPurpose.email_verification,
      'supabase-user-id',
    );
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'admin@example.com',
        template: 'auth_verification',
      }),
    );
  });

  it('bootstraps the first ADM with the password selected for initial sign-in', async () => {
    const { service, admin, users, emailOtp } = createAuthService();
    admin.createUser.mockResolvedValue({
      data: { user: { id: 'supabase-user-id', email: 'admin@example.com' } },
      error: null,
    });

    await expect(
      service.createFirstAdminAccount(
        'ADMIN@example.com',
        'a-user-selected-strong-password',
      ),
    ).resolves.toEqual({
      id: 'admin-user-id',
      email: 'admin@example.com',
      role: 'ADM',
      emailVerificationRequired: true,
      passwordSetupRequired: false,
    });

    expect(admin.createUser).toHaveBeenCalledWith({
      email: 'admin@example.com',
      password: 'a-user-selected-strong-password',
      email_confirm: false,
    });
    expect(users.createFirstAdminIdentity).toHaveBeenCalledWith(
      'supabase-user-id',
      'admin@example.com',
    );
    expect(users.createAdminIdentity).not.toHaveBeenCalled();
    expect(emailOtp.issue).toHaveBeenCalledWith(
      'admin@example.com',
      EmailOtpPurpose.email_verification,
      'supabase-user-id',
    );
  });

  it('links a verified GitHub identity to a customer profile', async () => {
    const { service, publicAuth, users } = createAuthService();

    await expect(
      service.completeGithubOAuth('supabase-access-token'),
    ).resolves.toEqual({ authenticated: true });

    expect(publicAuth.getUser).toHaveBeenCalledWith('supabase-access-token');
    expect(users.upsertCustomerFromOAuth).toHaveBeenCalledWith(
      'github-user-id',
      'github@example.com',
    );
  });

  it('rejects unverified GitHub identities', async () => {
    const { service, publicAuth, users } = createAuthService();
    publicAuth.getUser.mockResolvedValue({
      data: {
        user: {
          id: 'other-user-id',
          email: 'user@example.com',
          email_confirmed_at: null,
          app_metadata: { provider: 'github', providers: ['github'] },
        },
      },
      error: null,
    });

    await expect(
      service.completeGithubOAuth('supabase-access-token'),
    ).rejects.toMatchObject({ status: 401 });
    expect(users.upsertCustomerFromOAuth).not.toHaveBeenCalled();
  });

  it('rejects verified identities that did not authenticate with GitHub', async () => {
    const { service, publicAuth, users } = createAuthService();
    publicAuth.getUser.mockResolvedValue({
      data: {
        user: {
          id: 'email-user-id',
          email: 'user@example.com',
          email_confirmed_at: '2026-10-25T00:00:00.000Z',
          app_metadata: { provider: 'email', providers: ['email'] },
        },
      },
      error: null,
    });

    await expect(
      service.completeGithubOAuth('supabase-access-token'),
    ).rejects.toMatchObject({ status: 401 });
    expect(users.upsertCustomerFromOAuth).not.toHaveBeenCalled();
  });

  it('returns unauthorized when Supabase rejects the OAuth access token', async () => {
    const { service, publicAuth, users } = createAuthService();
    publicAuth.getUser.mockResolvedValue({
      data: { user: null },
      error: Object.assign(new Error('Invalid JWT'), { status: 401 }),
    });

    await expect(
      service.completeGithubOAuth('invalid-access-token'),
    ).rejects.toMatchObject({ status: 401 });
    expect(users.upsertCustomerFromOAuth).not.toHaveBeenCalled();
  });

  it('cleans up the identity and staff profile when the verification email fails', async () => {
    const { service, admin, users, emailOtp, email } = createAuthService();
    admin.createUser.mockResolvedValue({
      data: { user: { id: 'supabase-user-id', email: 'admin@example.com' } },
      error: null,
    });
    email.send.mockRejectedValue(new Error('Resend rejected the message'));

    await expect(
      service.createAdminAccount('admin@example.com', 'creator-id'),
    ).rejects.toMatchObject({ status: 503 });

    expect(emailOtp.cancel).toHaveBeenCalledWith(
      'admin@example.com',
      EmailOtpPurpose.email_verification,
      'supabase-user-id',
    );
    expect(users.removeProvisionedAdmin).toHaveBeenCalledWith(
      'supabase-user-id',
    );
    expect(admin.deleteUser).toHaveBeenCalledWith('supabase-user-id');
  });

  it('cleans up the Supabase identity when its returned email does not match', async () => {
    const { service, admin, users } = createAuthService();
    admin.createUser.mockResolvedValue({
      data: {
        user: { id: 'new-identity-id', email: 'unexpected@example.com' },
      },
      error: null,
    });

    await expect(
      service.createAdminAccount('admin@example.com', 'creator-id'),
    ).rejects.toMatchObject({ status: 503 });

    expect(users.createAdminIdentity).not.toHaveBeenCalled();
    expect(admin.deleteUser).toHaveBeenCalledWith('new-identity-id');
  });

  it('returns a conflict and removes the identity when the email is already linked', async () => {
    const { service, admin, users } = createAuthService();
    admin.createUser.mockResolvedValue({
      data: { user: { id: 'new-identity-id', email: 'admin@example.com' } },
      error: null,
    });
    users.createAdminIdentity.mockRejectedValue(
      new ConflictException(
        'An account with this email or identity already exists',
      ),
    );

    await expect(
      service.createAdminAccount('admin@example.com', 'creator-id'),
    ).rejects.toMatchObject({ status: 409 });

    expect(admin.deleteUser).toHaveBeenCalledWith('new-identity-id');
    expect(users.removeProvisionedAdmin).not.toHaveBeenCalled();
  });

  it('reports incomplete cleanup if the pending admin profile cannot be removed', async () => {
    const { service, admin, users, email } = createAuthService();
    admin.createUser.mockResolvedValue({
      data: { user: { id: 'new-identity-id', email: 'admin@example.com' } },
      error: null,
    });
    email.send.mockRejectedValue(new Error('Resend rejected the message'));
    users.removeProvisionedAdmin.mockRejectedValue(new Error('delete failed'));

    await expect(
      service.createAdminAccount('admin@example.com', 'creator-id'),
    ).rejects.toMatchObject({
      status: 503,
      message:
        'Admin account creation failed and cleanup was incomplete; contact support',
    });

    expect(admin.deleteUser).toHaveBeenCalledWith('new-identity-id');
  });

  it('removes the unverified identity and code when verification email delivery fails', async () => {
    const { service, admin, emailOtp, email } = createAuthService();
    email.send.mockRejectedValue(new Error('Resend rejected the message'));

    await expect(
      service.signUp('user@example.com', 'valid-password'),
    ).rejects.toMatchObject({ status: 503 });

    expect(emailOtp.cancel).toHaveBeenCalledWith(
      'user@example.com',
      EmailOtpPurpose.email_verification,
      'supabase-user-id',
    );
    expect(admin.deleteUser).toHaveBeenCalledWith('supabase-user-id');
  });

  it('reports cleanup failure explicitly when the unverified identity cannot be removed', async () => {
    const { service, admin, email } = createAuthService();
    email.send.mockRejectedValue(new Error('Resend rejected the message'));
    admin.deleteUser.mockResolvedValue({
      data: { user: null },
      error: new Error('delete failed'),
    });

    await expect(
      service.signUp('user@example.com', 'valid-password'),
    ).rejects.toMatchObject({
      status: 503,
      message:
        'Signup failed and cleanup of the unverified account was incomplete; contact support',
    });
  });

  it('confirms an identity using the email and code', async () => {
    const { service, admin, publicAuth, users, emailOtp } = createAuthService();

    await expect(
      service.confirmEmail('USER@example.com', '123456'),
    ).resolves.toEqual({
      email: 'user@example.com',
      emailVerified: true,
    });

    expect(emailOtp.verify).toHaveBeenCalledWith(
      'user@example.com',
      '123456',
      EmailOtpPurpose.email_verification,
    );
    expect(admin.updateUserById).toHaveBeenCalledWith('supabase-user-id', {
      email_confirm: true,
    });
    expect(users.upsertFromIdentity).toHaveBeenCalledWith(
      'supabase-user-id',
      'user@example.com',
      true,
    );
    expect(publicAuth.verifyOtp).not.toHaveBeenCalled();
  });

  it('does not confirm an identity if its email differs from the OTP email', async () => {
    const { service, admin, users } = createAuthService();
    admin.getUserById.mockResolvedValue({
      data: { user: { id: 'supabase-user-id', email: 'changed@example.com' } },
      error: null,
    });

    await expect(
      service.confirmEmail('user@example.com', '123456'),
    ).rejects.toMatchObject({ status: 401 });

    expect(admin.updateUserById).not.toHaveBeenCalled();
    expect(users.upsertFromIdentity).not.toHaveBeenCalled();
  });

  it('resends signup codes through Resend for unconfirmed identities', async () => {
    const { service, admin, publicAuth, emailOtp, email } = createAuthService();
    admin.listUsers.mockResolvedValue({
      data: {
        users: [{ id: 'supabase-user-id', email: 'user@example.com' }],
        nextPage: null,
      },
      error: null,
    });

    await expect(
      service.resendVerification('user@example.com'),
    ).resolves.toEqual({ email: 'user@example.com', sent: true });

    expect(emailOtp.issue).toHaveBeenCalledWith(
      'user@example.com',
      EmailOtpPurpose.email_verification,
      'supabase-user-id',
    );
    expect(email.send).toHaveBeenCalled();
    expect(publicAuth.resend).not.toHaveBeenCalled();
  });

  it('returns the same response when a verification code is cooling down', async () => {
    const { service, admin, emailOtp, email } = createAuthService();
    admin.listUsers.mockResolvedValue({
      data: {
        users: [
          {
            id: 'supabase-user-id',
            email: 'user@example.com',
            email_confirmed_at: null,
          },
        ],
        nextPage: null,
      },
      error: null,
    });
    emailOtp.issue.mockRejectedValue(new EmailOtpCooldownException());

    await expect(
      service.resendVerification('user@example.com'),
    ).resolves.toEqual({ email: 'user@example.com', sent: true });
    expect(email.send).not.toHaveBeenCalled();
  });

  it('sends password recovery codes through Resend and updates passwords through the admin API', async () => {
    const { service, admin, publicAuth, emailOtp, email } = createAuthService();
    admin.listUsers.mockResolvedValue({
      data: {
        users: [
          {
            id: 'supabase-user-id',
            email: 'user@example.com',
            email_confirmed_at: '2026-10-23T00:00:00.000Z',
          },
        ],
        nextPage: null,
      },
      error: null,
    });

    await expect(
      service.requestPasswordReset('user@example.com'),
    ).resolves.toEqual({ email: 'user@example.com', sent: true });
    expect(emailOtp.issue).toHaveBeenCalledWith(
      'user@example.com',
      EmailOtpPurpose.password_reset,
      'supabase-user-id',
    );
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        template: 'password_reset',
        variables: { CODE: '123456', EXPIRY_MINUTES: 10 },
      }),
    );

    await expect(
      service.resetPassword('user@example.com', '654321', 'new-password'),
    ).resolves.toEqual({
      email: 'user@example.com',
      passwordReset: true,
    });
    expect(emailOtp.verify).toHaveBeenCalledWith(
      'user@example.com',
      '654321',
      EmailOtpPurpose.password_reset,
    );
    expect(admin.updateUserById).toHaveBeenCalledWith('supabase-user-id', {
      password: 'new-password',
    });
    expect(publicAuth.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(publicAuth.verifyOtp).not.toHaveBeenCalled();
    expect(publicAuth.updateUser).not.toHaveBeenCalled();
  });

  it('returns the same response when a password-reset code is cooling down', async () => {
    const { service, admin, emailOtp, email } = createAuthService();
    admin.listUsers.mockResolvedValue({
      data: {
        users: [
          {
            id: 'supabase-user-id',
            email: 'user@example.com',
            email_confirmed_at: '2026-10-23T00:00:00.000Z',
          },
        ],
        nextPage: null,
      },
      error: null,
    });
    emailOtp.issue.mockRejectedValue(new EmailOtpCooldownException());

    await expect(
      service.requestPasswordReset('user@example.com'),
    ).resolves.toEqual({ email: 'user@example.com', sent: true });
    expect(email.send).not.toHaveBeenCalled();
  });

  it('keeps Supabase Auth rate limits as HTTP 429', async () => {
    const { service, admin } = createAuthService();
    admin.createUser.mockResolvedValue({
      data: { user: null },
      error: {
        code: 'over_email_send_rate_limit',
        message: 'private provider error',
        status: 429,
      },
    });

    await expect(
      service.signUp('user@example.com', 'valid-password'),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('logs only safe auth error fields', async () => {
    const warning = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const { service, admin } = createAuthService();
    admin.createUser.mockResolvedValue({
      data: { user: null },
      error: {
        code: 'email_exists',
        message: 'private provider details user@example.com',
        status: 400,
      },
    });

    await expect(
      service.signUp('user@example.com', 'private-password'),
    ).rejects.toMatchObject({ status: 409 });

    const loggedOutput = warning.mock.calls.flat().join(' ');
    expect(loggedOutput).toContain('"errorCode":"email_exists"');
    expect(loggedOutput).toContain('"statusCode":400');
    expect(loggedOutput).not.toContain('user@example.com');
    expect(loggedOutput).not.toContain('private-password');
    expect(loggedOutput).not.toContain('private provider details');
  });

  it('keeps password login on Supabase Auth without using email delivery', async () => {
    const { service, publicAuth, email } = createAuthService();

    await expect(
      service.login('user@example.com', 'valid-password'),
    ).resolves.toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });

    expect(publicAuth.signInWithPassword).toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('does not issue application tokens to suspended accounts', async () => {
    const { service, users } = createAuthService();
    users.upsertFromIdentity.mockResolvedValue({
      suspendedAt: new Date(),
    } as never);

    await expect(
      service.login('user@example.com', 'valid-password'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('returns the rotated refresh token when refreshing a Supabase session', async () => {
    const { service, publicAuth } = createAuthService();
    publicAuth.refreshSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'refreshed-access-token',
          refresh_token: 'rotated-refresh-token',
          expires_in: 3600,
          token_type: 'bearer',
        },
      },
      error: null,
    });

    await expect(service.refresh('previous-refresh-token')).resolves.toEqual({
      accessToken: 'refreshed-access-token',
      idToken: 'refreshed-access-token',
      refreshToken: 'rotated-refresh-token',
      expiresIn: 3600,
      tokenType: 'bearer',
    });
    expect(publicAuth.refreshSession).toHaveBeenCalledWith({
      refresh_token: 'previous-refresh-token',
    });
  });

  it('logs safe provider details when password login is unavailable', async () => {
    const warning = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const { service, publicAuth } = createAuthService();
    publicAuth.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: Object.assign(
        new Error('private provider detail admin@example.com'),
        { code: 'unexpected_failure', status: 503 },
      ),
    });

    await expect(
      service.login('admin@example.com', 'private-password'),
    ).rejects.toMatchObject({ status: 503 });

    const loggedOutput = warning.mock.calls.flat().join(' ');
    expect(loggedOutput).toContain('"operation":"login"');
    expect(loggedOutput).toContain('"errorCode":"unexpected_failure"');
    expect(loggedOutput).toContain('"statusCode":503');
    expect(loggedOutput).not.toContain('admin@example.com');
    expect(loggedOutput).not.toContain('private-password');
    expect(loggedOutput).not.toContain('private provider detail');
  });
});
