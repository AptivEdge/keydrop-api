import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { EmailOtpPurpose } from '../../../generated/prisma/enums.js';
import { EmailOtpService } from './email-otp.service.js';

describe('EmailOtpService', () => {
  function createService() {
    const emailOtp = {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({ attempts: 1 }),
    };
    const prisma = { emailOtp };
    const secret = 'p'.repeat(32);
    const config = { get: vi.fn().mockReturnValue(secret) };
    return {
      service: new EmailOtpService(
        prisma as never,
        config as unknown as ConfigService,
      ),
      emailOtp,
      secret,
      config,
    };
  }

  it('stores a purpose-scoped HMAC instead of the emailed OTP', async () => {
    const { service, emailOtp, secret } = createService();

    const { code } = await service.issue(
      ' USER@example.com ',
      EmailOtpPurpose.email_verification,
      'supabase-user-id',
    );

    expect(code).toMatch(/^\d{6}$/);
    expect(emailOtp.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: 'user@example.com',
        purpose: EmailOtpPurpose.email_verification,
        identitySubject: 'supabase-user-id',
        codeHash: createHmac('sha256', secret).update(code).digest('hex'),
      }),
    });
    expect(JSON.stringify(emailOtp.create.mock.calls)).not.toContain(code);
  });

  it('verifies and consumes a code only for its matching purpose', async () => {
    const { service, emailOtp, secret } = createService();
    const code = '123456';
    emailOtp.findFirst.mockResolvedValue({
      id: 'otp-id',
      attempts: 0,
      maxAttempts: 5,
      codeHash: createHmac('sha256', secret).update(code).digest('hex'),
      identitySubject: 'supabase-user-id',
    });

    await expect(
      service.verify('user@example.com', code, EmailOtpPurpose.password_reset),
    ).resolves.toEqual({ identitySubject: 'supabase-user-id' });
    expect(emailOtp.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          email: 'user@example.com',
          purpose: EmailOtpPurpose.password_reset,
        }),
      }),
    );
    expect(emailOtp.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'otp-id', consumedAt: null },
      }),
    );
  });

  it('cancels only the pending verification code for the failed signup identity', async () => {
    const { service, emailOtp } = createService();

    await service.cancel(
      ' USER@example.com ',
      EmailOtpPurpose.email_verification,
      'supabase-user-id',
    );

    expect(emailOtp.updateMany).toHaveBeenCalledWith({
      where: {
        email: 'user@example.com',
        purpose: EmailOtpPurpose.email_verification,
        identitySubject: 'supabase-user-id',
        consumedAt: null,
      },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it('only finds an identity from an unexpired OTP of the requested purpose', async () => {
    const { service, emailOtp } = createService();
    emailOtp.findFirst.mockResolvedValue({
      identitySubject: 'supabase-user-id',
    });

    await expect(
      service.findIdentitySubject(
        'USER@example.com',
        EmailOtpPurpose.email_verification,
      ),
    ).resolves.toBe('supabase-user-id');
    expect(emailOtp.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          email: 'user@example.com',
          purpose: EmailOtpPurpose.email_verification,
          expiresAt: { gt: expect.any(Date) },
        }),
      }),
    );
  });

  it('fails closed without a sufficiently long OTP pepper', async () => {
    const { service, emailOtp, config } = createService();
    config.get.mockReturnValue('short');

    await expect(
      service.issue('user@example.com', EmailOtpPurpose.email_verification),
    ).rejects.toMatchObject({ status: 503 });
    expect(emailOtp.create).not.toHaveBeenCalled();
    expect(emailOtp.updateMany).not.toHaveBeenCalled();
  });
});
