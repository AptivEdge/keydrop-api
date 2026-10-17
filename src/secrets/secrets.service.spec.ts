import { ConflictException, NotFoundException } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { SecretsService } from './secrets.service.js';
import { AccountService } from '../account/account.service.js';

describe('SecretsService', () => {
  it('creates anonymous secrets without an owner', async () => {
    const created = { id: 'anonymous-1', status: 'active' };
    const prisma = {
      secret: { create: vi.fn().mockResolvedValue(created) },
    };
    const service = new SecretsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await service.createAnonymous({
      ciphertextRef: 'ciphertext',
      iv: 'iv',
      wrappedKey: 'wrapped-key',
      salt: 'salt',
      maxViews: 3,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    expect(result).toBe(created);
    expect(prisma.secret.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ownerId: null, maxViews: 3 }),
      }),
    );
  });

  it('rejects anonymous secrets without an expiry', async () => {
    const prisma = { secret: { create: vi.fn() } };
    const service = new SecretsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.createAnonymous({
        ciphertextRef: 'ciphertext',
        iv: 'iv',
        wrappedKey: 'wrapped-key',
        salt: 'salt',
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(prisma.secret.create).not.toHaveBeenCalled();
  });

  it('rejects anonymous secrets above the view limit', async () => {
    const prisma = { secret: { create: vi.fn() } };
    const service = new SecretsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.createAnonymous({
        ciphertextRef: 'ciphertext',
        iv: 'iv',
        wrappedKey: 'wrapped-key',
        salt: 'salt',
        maxViews: 4,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(prisma.secret.create).not.toHaveBeenCalled();
  });

  it('enforces the free-plan expiry limit before writing', async () => {
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
          ciphertextRef: 'ciphertext',
          iv: 'iv',
          wrappedKey: 'wrapped-key',
          salt: 'salt',
          expiresAt: new Date(
            Date.now() + 8 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: vi.fn((key: string) =>
        key === 'S3_REGION' ? 'ap-south-1' : 'test-bucket',
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

  it('does not complete a file when its object is missing in S3', async () => {
    const prisma = {
      file: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'file-1',
          storageRef: 'secrets/secret-1/files/file.txt',
          sizeBytes: 12n,
          contentType: 'text/plain',
          uploadedAt: null,
        }),
        updateMany: vi.fn(),
      },
    };
    const config = {
      get: vi.fn((key: string) =>
        key === 'S3_REGION' ? 'ap-south-1' : 'test-bucket',
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
