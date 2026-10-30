import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { createHmac } from 'node:crypto';
import { SecretsService } from './secrets.service.js';
import { AccountService } from '../account/account.service.js';

const ciphertext = Buffer.from('encrypted-ciphertext').toString('base64url');
const iv = Buffer.alloc(12).toString('base64url');

describe('SecretsService', () => {
  it('rejects anonymous secret creation', async () => {
    const secretCreate = vi.fn();
    const prisma = { secret: { create: secretCreate } };
    const service = new SecretsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.createAnonymous()).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(secretCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['pro', 256 * 1024 + 16],
    ['pro', 256 * 1024 + 4 + 16],
    ['team', 256 * 1024 + 4 + 16],
  ])(
    'accepts padded ciphertext at the %s plan boundary',
    async (plan, byteLength) => {
      const created = {
        id: 'A1b2C3d4E5f6G7h8I9j0K1',
        status: 'active',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        maxViews: 1,
      };
      const secretCreate = vi.fn().mockResolvedValue(created);
      const prisma = {
        secret: { create: secretCreate },
        $transaction: vi.fn((callback: (tx: unknown) => Promise<unknown>) =>
          callback({
            secret: { create: secretCreate },
            auditEvent: { create: vi.fn().mockResolvedValue({}) },
          }),
        ),
      };
      const service = new SecretsService(
        prisma as never,
        { get: vi.fn() } as never,
        {} as never,
        {} as never,
      );
      const payload = {
        ciphertext: Buffer.alloc(byteLength).toString('base64url'),
        iv,
        kdf: { algorithm: 'HKDF-SHA-256' as const },
        max_views: 1,
        expires_in: 60 * 60,
      };

      await service.create({ userId: 'user-1', plan } as never, payload);

      expect(secretCreate).toHaveBeenCalledOnce();
    },
  );

  it('stores only a peppered HMAC of the client-derived passphrase auth value', async () => {
    const pepper = 'test-pepper-that-is-at-least-32-bytes';
    const authBytes = Buffer.alloc(32, 7);
    const auth = authBytes.toString('base64url');
    const created = {
      id: 'A1b2C3d4E5f6G7h8I9j0K1',
      status: 'active',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      maxViews: 1,
    };
    const secretCreate = vi.fn().mockResolvedValue(created);
    const auditCreate = vi.fn().mockResolvedValue({});
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          secret: { create: secretCreate },
          auditEvent: { create: auditCreate },
        }),
      ),
    };
    const config = { get: vi.fn(() => pepper) };
    const service = new SecretsService(
      prisma as never,
      config as never,
      {} as never,
      {} as never,
    );

    await service.create({ userId: 'user-1', plan: 'pro' } as never, {
      ciphertext,
      iv,
      kdf: {
        algorithm: 'Argon2id',
        salt: Buffer.alloc(16, 9).toString('base64url'),
        parameters: { m: 65536, t: 3, p: 1 },
      },
      auth,
      expires_in: 3600,
    });

    const data = secretCreate.mock.calls[0]?.[0].data;
    expect(data).toEqual(
      expect.objectContaining({
        authHash: createHmac('sha256', pepper).update(authBytes).digest('hex'),
        id: expect.stringMatching(/^[0-9A-Za-z]{22}$/),
        ciphertext,
        ciphertextRef: null,
      }),
    );
    expect(data).not.toHaveProperty('auth');
  });

  it('rejects secret creation for free accounts before writing', async () => {
    const prisma = { secret: { create: vi.fn() } };
    const transaction = vi.fn();
    const service = new SecretsService(
      { ...prisma, $transaction: transaction } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.create({ userId: 'user-1', plan: 'free' } as never, {
        ciphertext,
        iv,
        kdf: { algorithm: 'HKDF-SHA-256' },
        expires_in: 60 * 60,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.secret.create).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects free-plan secret creation before checking expiry limits', async () => {
    const prisma = { $transaction: vi.fn() };
    const config = { get: vi.fn() };
    const service = new SecretsService(
      prisma as never,
      config as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.create(
        {
          userId: 'user-1',
          plan: 'free',
        } as never,
        {
          ciphertext,
          iv,
          kdf: { algorithm: 'HKDF-SHA-256' },
          expires_in: 8 * 24 * 60 * 60,
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects file uploads for free-plan accounts before contacting storage', async () => {
    const configGet = vi.fn();
    const prisma = {
      secret: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'secret-1',
          owner: { plan: 'free' },
        }),
      },
    };
    const service = new SecretsService(
      prisma as never,
      { get: configGet } as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.createFileUpload('secret-1', 'owner-1', {
        filename: 'file.txt',
        contentType: 'text/plain',
        sizeBytes: 12,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(configGet).not.toHaveBeenCalled();
  });

  it('returns encrypted material and clears it in the final-view transaction', async () => {
    const payload = Buffer.from('encrypted').toString('base64url');
    const kdf = { algorithm: 'HKDF-SHA-256' };
    const candidate = {
      authHash: null,
      ciphertext: payload,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      status: 'active',
      maxViews: 1,
      viewsUsed: 0,
      passphraseAttempts: 0,
      recipientEmailHash: null,
    };
    const tx = {
      secret: {
        findUnique: vi.fn().mockResolvedValue({
          ciphertext: payload,
          ciphertextRef: null,
          iv,
          kdf,
          wrappedKey: null,
          salt: null,
          files: [],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      secret: { findUnique: vi.fn().mockResolvedValue(candidate) },
      $transaction: vi.fn(
        async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    const service = new SecretsService(
      prisma as never,
      {} as never,
      {} as never,
      { purgeSecret: vi.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(service.reveal('A1b2C3d4E5f6G7h8I9j0K1', {})).resolves.toEqual(
      { ciphertext: payload, iv, kdf },
    );
    expect(tx.secret.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ viewsUsed: 0, status: 'active' }),
        data: expect.objectContaining({
          viewsUsed: 1,
          status: 'viewed',
          ciphertext: null,
        }),
      }),
    );
  });

  it('does not delete a secret owned by another user', async () => {
    const prisma = {
      secret: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const service = new AccountService(prisma as never);

    await expect(
      service.deleteTerminalSecret('attacker', 'secret-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.secret.findFirst).toHaveBeenCalledWith({
      where: { id: 'secret-1', ownerId: 'attacker' },
      select: { id: true, status: true },
    });
  });

  it('verifies file size and content type before completing an upload', async () => {
    const prisma = {
      file: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'file-1',
          storageRef: 'secrets/secret-1/files/file.txt',
          sizeBytes: 12n,
          contentType: 'text/plain',
          uploadedAt: null,
          secret: { owner: { plan: 'pro' } },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: vi.fn((key: string) =>
        key === 'STORAGE_PROVIDER'
          ? 'r2'
          : key === 'R2_BUCKET_NAME'
            ? 'test-bucket'
            : key === 'R2_ACCOUNT_ID'
              ? 'test-account'
              : key === 'R2_ACCESS_KEY_ID'
                ? 'test-access-key'
                : key === 'R2_SECRET_ACCESS_KEY'
                  ? 'test-secret-key'
                  : undefined,
      ),
    };
    const headObject = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({
      ContentLength: 12,
      ContentType: 'text/plain',
    } as never);
    const service = new SecretsService(
      prisma as never,
      config as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.completeFileUpload('secret-1', 'file-1', 'owner-1'),
    ).resolves.toEqual({
      id: 'file-1',
      uploaded: true,
      alreadyCompleted: false,
    });
    expect(prisma.file.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'file-1',
          uploadedAt: null,
          secret: expect.objectContaining({
            ownerId: 'owner-1',
            status: 'active',
            OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
          }),
        }),
      }),
    );
    headObject.mockRestore();
  });

  it('does not complete a file when its object is missing from storage', async () => {
    const prisma = {
      file: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'file-1',
          storageRef: 'secrets/secret-1/files/file.txt',
          sizeBytes: 12n,
          contentType: 'text/plain',
          uploadedAt: null,
          secret: { owner: { plan: 'pro' } },
        }),
        updateMany: vi.fn(),
      },
    };
    const config = {
      get: vi.fn((key: string) =>
        key === 'STORAGE_PROVIDER'
          ? 'r2'
          : key === 'R2_BUCKET_NAME'
            ? 'test-bucket'
            : key === 'R2_ACCOUNT_ID'
              ? 'test-account'
              : key === 'R2_ACCESS_KEY_ID'
                ? 'test-access-key'
                : key === 'R2_SECRET_ACCESS_KEY'
                  ? 'test-secret-key'
                  : undefined,
      ),
    };
    const headObject = vi.spyOn(S3Client.prototype, 'send').mockRejectedValue({
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
    const service = new SecretsService(
      prisma as never,
      config as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.completeFileUpload('secret-1', 'file-1', 'owner-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.file.updateMany).not.toHaveBeenCalled();
    headObject.mockRestore();
  });

  it('does not delete an active secret', async () => {
    const prisma = {
      secret: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: 'secret-1', status: 'active' }),
        delete: vi.fn(),
      },
    };
    const service = new AccountService(prisma as never);

    await expect(
      service.deleteTerminalSecret('owner-1', 'secret-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.secret.delete).not.toHaveBeenCalled();
  });
});
