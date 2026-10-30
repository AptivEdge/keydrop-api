import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { UsersService } from './users.service.js';

describe('UsersService', () => {
  it('creates the first ADM while holding the bootstrap lock', async () => {
    const profile = {
      id: 'admin-user-id',
      email: 'admin@example.com',
      identitySubject: 'supabase-admin-id',
      adminUser: { role: 'ADM' },
    };
    const transaction = {
      $queryRaw: vi.fn(),
      adminUser: { count: vi.fn().mockResolvedValue(0) },
      user: { create: vi.fn().mockResolvedValue(profile) },
    };
    const prisma = {
      $transaction: vi.fn(
        async (operation: (tx: typeof transaction) => unknown) =>
          operation(transaction),
      ),
    };
    const service = new UsersService(prisma as never);

    await expect(
      service.createFirstAdminIdentity(
        'supabase-admin-id',
        ' ADMIN@example.com ',
      ),
    ).resolves.toEqual(profile);

    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(transaction.adminUser.count).toHaveBeenCalledWith({
      where: { role: 'ADM' },
    });
    expect(transaction.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'admin@example.com',
          identitySubject: 'supabase-admin-id',
          adminUser: {
            create: {
              role: 'ADM',
              ssoSubject: 'supabase-admin-id',
            },
          },
        }),
      }),
    );
  });

  it('does not create another first ADM once one exists', async () => {
    const transaction = {
      $queryRaw: vi.fn(),
      adminUser: { count: vi.fn().mockResolvedValue(1) },
      user: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(
        async (operation: (tx: typeof transaction) => unknown) =>
          operation(transaction),
      ),
    };
    const service = new UsersService(prisma as never);

    await expect(
      service.createFirstAdminIdentity(
        'supabase-admin-id',
        'admin@example.com',
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(transaction.user.create).not.toHaveBeenCalled();
  });

  it('links an existing profile only after the identity email is verified', async () => {
    const uniqueViolation = Object.assign(new Error('unique violation'), {
      code: 'P2002',
    });
    const profile = {
      id: 'existing-profile-id',
      email: 'user@example.com',
      identitySubject: 'supabase-user-id',
    };
    const user = {
      upsert: vi.fn().mockRejectedValue(uniqueViolation),
      findUnique: vi.fn().mockResolvedValue({
        id: 'existing-profile-id',
        deletedAt: null,
      }),
      update: vi.fn().mockResolvedValue(profile),
    };
    const service = new UsersService({ user } as never);

    await expect(
      service.upsertFromIdentity(
        'supabase-user-id',
        'USER@example.com',
        true,
      ),
    ).resolves.toEqual(profile);

    expect(user.findUnique).toHaveBeenCalledWith({
      where: { email: 'user@example.com' },
      select: { id: true, deletedAt: true },
    });
    expect(user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'existing-profile-id' },
        data: expect.objectContaining({
          identitySubject: 'supabase-user-id',
          emailVerifiedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('does not link an existing profile for an unverified identity', async () => {
    const uniqueViolation = Object.assign(new Error('unique violation'), {
      code: 'P2002',
    });
    const user = {
      upsert: vi.fn().mockRejectedValue(uniqueViolation),
      findUnique: vi.fn(),
      update: vi.fn(),
    };
    const service = new UsersService({ user } as never);

    await expect(
      service.upsertFromIdentity(
        'supabase-user-id',
        'user@example.com',
        false,
      ),
    ).rejects.toBe(uniqueViolation);
    expect(user.findUnique).not.toHaveBeenCalled();
    expect(user.update).not.toHaveBeenCalled();
  });

  it('does not relink a profile whose identity subject is already in use', async () => {
    const uniqueViolation = Object.assign(new Error('unique violation'), {
      code: 'P2002',
    });
    const user = {
      upsert: vi.fn().mockRejectedValueOnce(uniqueViolation),
      findUnique: vi.fn().mockResolvedValue({
        id: 'existing-profile-id',
        deletedAt: null,
      }),
      update: vi.fn().mockRejectedValueOnce(uniqueViolation),
    };
    const service = new UsersService({ user } as never);

    await expect(
      service.upsertFromIdentity(
        'supabase-user-id',
        'user@example.com',
        true,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(user.update).toHaveBeenCalledTimes(1);
  });

  it('creates a customer profile for a verified OAuth identity', async () => {
    const profile = { id: 'profile-id', email: 'github@example.com' };
    const user = {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(profile),
      update: vi.fn(),
    };
    const prisma = {
      user,
      $transaction: vi.fn(async (operation: (transaction: unknown) => unknown) =>
        operation({ user }),
      ),
    };
    const service = new UsersService(prisma as never);

    await expect(
      service.upsertCustomerFromOAuth(
        'github-user-id',
        'GITHUB@example.com',
      ),
    ).resolves.toBe(profile);

    expect(user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'github@example.com',
          identitySubject: 'github-user-id',
          emailVerifiedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('does not allow GitHub OAuth to sign into a staff profile', async () => {
    const user = {
      findUnique: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'staff-profile-id',
          adminUser: { role: 'ADM' },
        }),
      create: vi.fn(),
      update: vi.fn(),
    };
    const prisma = {
      user,
      $transaction: vi.fn(async (operation: (transaction: unknown) => unknown) =>
        operation({ user }),
      ),
    };
    const service = new UsersService(prisma as never);

    await expect(
      service.upsertCustomerFromOAuth(
        'github-user-id',
        'staff@example.com',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(user.create).not.toHaveBeenCalled();
    expect(user.update).not.toHaveBeenCalled();
  });

  it('does not relink an email that belongs to a different customer identity', async () => {
    const user = {
      findUnique: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'existing-profile-id',
          identitySubject: 'existing-identity-id',
          deletedAt: null,
          adminUser: null,
        }),
      create: vi.fn(),
      update: vi.fn(),
    };
    const prisma = {
      user,
      $transaction: vi.fn(async (operation: (transaction: unknown) => unknown) =>
        operation({ user }),
      ),
    };
    const service = new UsersService(prisma as never);

    await expect(
      service.upsertCustomerFromOAuth(
        'github-user-id',
        'user@example.com',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(user.update).not.toHaveBeenCalled();
    expect(user.create).not.toHaveBeenCalled();
  });

  it('suspends customers and writes an audit record atomically', async () => {
    const user = {
      id: 'customer-id',
      email: 'customer@example.com',
      suspendedAt: new Date(),
      suspensionReason: 'Abuse report investigation',
    };
    const transaction = {
      user: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue(user),
      },
      adminAuditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      user: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'customer-id',
          adminUser: null,
          suspendedAt: null,
        }),
      },
      $transaction: vi.fn(
        async (operation: (tx: typeof transaction) => unknown) =>
          operation(transaction),
      ),
    };
    const service = new UsersService(prisma as never);

    await expect(
      service.setSuspended(
        'customer-id',
        'staff-id',
        'Abuse report investigation',
        true,
      ),
    ).resolves.toBe(user);

    expect(transaction.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'customer-id',
          suspendedAt: null,
        }),
      }),
    );
    expect(transaction.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'staff-id',
        action: 'user_suspended',
        targetId: 'customer-id',
        reason: 'Abuse report investigation',
      }),
    });
  });

  it('rejects self-moderation, staff targets, and short reasons', async () => {
    const prisma = {
      user: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'staff-id',
          adminUser: { role: 'ADM' },
          suspendedAt: null,
        }),
      },
    };
    const service = new UsersService(prisma as never);

    await expect(
      service.setSuspended('customer-id', 'staff-id', 'Too short', true),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.setSuspended('staff-id', 'staff-id', 'Reason is long enough', true),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.setSuspended('staff-id', 'other-staff', 'Reason is long enough', true),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
