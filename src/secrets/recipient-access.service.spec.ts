import { UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { RecipientAccessService } from './recipient-access.service.js';

const tokenSecret = 'recipient-token-test-secret-with-32-bytes';
const recipientHash = 'f'.repeat(64);

function hashCode(code: string): string {
  return createHmac('sha256', tokenSecret).update(code).digest('hex');
}

function createConfig() {
  return {
    get: vi.fn((key: string) => {
      if (key === 'RECIPIENT_ACCESS_TOKEN_SECRET') return tokenSecret;
      return undefined;
    }),
  };
}

describe('RecipientAccessService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emails one hashed six-digit code and exchanges it for a five-minute JWT', async () => {
    const secret = {
      id: 'A1b2C3d4E5f6G7h8I9j0K1',
      status: 'active',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      recipientEmail: 'recipient@example.com',
      recipientEmailHash: recipientHash,
    };
    const otpCreate = vi.fn().mockResolvedValue({ id: 'otp-1' });
    const prisma = {
      secret: { findUnique: vi.fn().mockResolvedValue(secret) },
      emailOtp: {
        findFirst: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: otpCreate,
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          $queryRaw: vi.fn().mockResolvedValue([{ id: secret.id }]),
          secret: { findUnique: vi.fn().mockResolvedValue(secret) },
          emailOtp: {
            findFirst: vi.fn().mockResolvedValue(null),
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            create: otpCreate,
          },
        }),
      ),
    };
    const email = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new RecipientAccessService(
      prisma as never,
      createConfig() as never,
      email as never,
    );

    await expect(service.sendCode(secret.id)).resolves.toEqual({ sent: true });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    const code = String(email.send.mock.calls[0]?.[0]?.variables?.CODE ?? '');
    expect(code).toMatch(/^\d{6}$/);
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        template: 'recipient_access',
        variables: { CODE: code, EXPIRY_MINUTES: 10 },
      }),
    );
    expect(otpCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          secretId: secret.id,
          email: secret.recipientEmail,
          codeHash: hashCode(code),
          maxAttempts: 5,
        }),
      }),
    );

    prisma.emailOtp.findFirst.mockResolvedValue({
      id: 'otp-1',
      codeHash: hashCode(code),
      attempts: 0,
      maxAttempts: 5,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const result = await service.verifyCode(secret.id, code);
    expect(result.expires_in).toBe(300);
    const [, encodedPayload] = result.access_token.split('.');
    expect(
      JSON.parse(Buffer.from(encodedPayload!, 'base64url').toString('utf8')),
    ).toEqual(
      expect.objectContaining({
        sub: secret.id,
        recipient_email_hash: recipientHash,
      }),
    );
    await expect(
      service.verify(secret.id, result.access_token),
    ).resolves.toBeUndefined();
  });

  it('counts invalid codes and never issues an access token', async () => {
    const prisma = {
      secret: { findUnique: vi.fn() },
      emailOtp: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'otp-1',
          codeHash: hashCode('123456'),
          attempts: 0,
          maxAttempts: 5,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = new RecipientAccessService(
      prisma as never,
      createConfig() as never,
      { send: vi.fn() } as never,
    );

    await expect(
      service.verifyCode('A1b2C3d4E5f6G7h8I9j0K1', '654321'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.emailOtp.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { attempts: { increment: 1 } },
      }),
    );
    expect(prisma.secret.findUnique).not.toHaveBeenCalled();
  });
});
