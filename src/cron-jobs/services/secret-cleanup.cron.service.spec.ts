import { describe, expect, it, vi } from 'vitest';
import { SecretCleanupCronService } from './secret-cleanup.cron.service';

describe('SecretCleanupCronService', () => {
  it('purges expired secret content while retaining the secret record', async () => {
    const secret = {
      id: 'secret-id',
      ciphertextRef: 'ciphertext-ref',
      files: [{ storageRef: 'file-ref' }],
    };
    const tx = {
      secret: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        deleteMany: vi.fn(),
      },
      auditEvent: { create: vi.fn().mockResolvedValue(undefined) },
      file: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      secret: { findMany: vi.fn().mockResolvedValue([secret]) },
      $transaction: vi.fn(
        (callback: (transaction: typeof tx) => Promise<void>) =>
          callback(tx),
      ),
    };
    const storagePurge = { purgeSecret: vi.fn().mockResolvedValue(undefined) };
    const service = new SecretCleanupCronService(
      prisma as never,
      storagePurge as never,
    );

    await service.runExpiredSecretCleanup();

    expect(storagePurge.purgeSecret).toHaveBeenCalledWith('secret-id', [
      'ciphertext-ref',
      'file-ref',
    ]);
    expect(tx.secret.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ciphertext: null,
          ciphertextRef: null,
          authHash: null,
          wrappedKey: null,
          salt: null,
        }),
      }),
    );
    expect(tx.secret.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['active', 'partially_viewed'] },
        }),
        data: { status: 'expired' },
      }),
    );
    expect(tx.auditEvent.create).toHaveBeenCalledWith({
      data: { eventType: 'secret_expired', secretId: 'secret-id' },
    });
    expect(tx.file.deleteMany).toHaveBeenCalledWith({
      where: { secretId: { in: ['secret-id'] } },
    });
    expect(tx.secret.deleteMany).not.toHaveBeenCalled();
    expect(prisma.secret.findMany).toHaveBeenCalledOnce();
  });
});
