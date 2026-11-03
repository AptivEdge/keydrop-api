import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { TeamsService } from './teams.service.js';

describe('TeamsService authorization', () => {
  function createService(membershipRole: 'owner' | 'admin' | 'member') {
    const prisma = {
      teamMember: {
        findUnique: vi.fn().mockResolvedValue({
          role: membershipRole,
          team: { suspendedAt: null },
        }),
        findFirst: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    };
    const service = new TeamsService(
      prisma as never,
      { get: vi.fn() } as never,
      {} as never,
    );
    return { service, prisma };
  }

  it('prevents members from renaming a team', async () => {
    const { service, prisma } = createService('member');

    await expect(
      service.updateName('user-1', 'team-1', 'New name'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.teamMember.findUnique).toHaveBeenCalled();
  });

  describe('TeamsService encryption keys', () => {
    const publicKey = {
      kty: 'EC',
      crv: 'P-256',
      x: Buffer.alloc(32, 1).toString('base64url'),
      y: Buffer.alloc(32, 2).toString('base64url'),
    };
    const encryptedPrivateKey = {
      version: 1,
      algorithm: 'AES-GCM',
      salt: Buffer.alloc(16, 3).toString('base64url'),
      iv: Buffer.alloc(12, 4).toString('base64url'),
      ciphertext: Buffer.alloc(128, 5).toString('base64url'),
      kdf: { algorithm: 'Argon2id', m: 65536, t: 3, p: 1 },
    };

    it('stores a P-256 public key and recovery-encrypted private-key backup', async () => {
      const prisma = {
        userEncryptionKey: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ publicKey, encryptedPrivateKey }),
        },
      };
      const service = new TeamsService(
        prisma as never,
        { get: vi.fn() } as never,
        {} as never,
      );

      await service.registerEncryptionKey(
        'user-1',
        publicKey,
        encryptedPrivateKey,
      );

      expect(prisma.userEncryptionKey.create).toHaveBeenCalledWith({
        data: { userId: 'user-1', publicKey, encryptedPrivateKey },
        select: { publicKey: true, encryptedPrivateKey: true, createdAt: true },
      });
    });

    it('rejects non-P-256 public keys without writing them', async () => {
      const prisma = {
        userEncryptionKey: { findUnique: vi.fn(), create: vi.fn() },
      };
      const service = new TeamsService(
        prisma as never,
        { get: vi.fn() } as never,
        {} as never,
      );

      await expect(
        service.registerEncryptionKey(
          'user-1',
          { kty: 'RSA' },
          encryptedPrivateKey,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.userEncryptionKey.create).not.toHaveBeenCalled();
    });

    it('rejects private JWK material in the public-key registration', async () => {
      const prisma = {
        userEncryptionKey: { findUnique: vi.fn(), create: vi.fn() },
      };
      const service = new TeamsService(
        prisma as never,
        { get: vi.fn() } as never,
        {} as never,
      );

      await expect(
        service.registerEncryptionKey(
          'user-1',
          { ...publicKey, d: Buffer.alloc(32, 9).toString('base64url') },
          encryptedPrivateKey,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.userEncryptionKey.findUnique).not.toHaveBeenCalled();
      expect(prisma.userEncryptionKey.create).not.toHaveBeenCalled();
    });

    it('does not silently replace an existing account encryption key', async () => {
      const prisma = {
        userEncryptionKey: {
          findUnique: vi.fn().mockResolvedValue({ userId: 'user-1' }),
          create: vi.fn(),
        },
      };
      const service = new TeamsService(
        prisma as never,
        { get: vi.fn() } as never,
        {} as never,
      );

      await expect(
        service.registerEncryptionKey('user-1', publicKey, encryptedPrivateKey),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.userEncryptionKey.create).not.toHaveBeenCalled();
    });
  });

  it('prevents admins from assigning administrator roles', async () => {
    const { service, prisma } = createService('admin');
    prisma.teamMember.findFirst.mockResolvedValue({
      id: 'member-1',
      userId: 'user-2',
      role: 'member',
    });

    await expect(
      service.updateMemberRole('admin-1', 'team-1', 'member-1', 'admin'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.teamMember.update).not.toHaveBeenCalled();
  });

  it('prevents removing the team owner', async () => {
    const { service, prisma } = createService('owner');
    prisma.teamMember.findFirst.mockResolvedValue({
      id: 'owner-membership',
      role: 'owner',
    });

    await expect(
      service.removeMember('owner-1', 'team-1', 'owner-membership'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.teamMember.delete).not.toHaveBeenCalled();
  });
});
