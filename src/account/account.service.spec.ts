import { AccountService } from './account.service.js';
import { ForbiddenException } from '@nestjs/common';

describe('AccountService account API', () => {
  it('returns cursor-paginated user secrets', async () => {
    const rows = [{ id: 'secret-3' }, { id: 'secret-2' }, { id: 'secret-1' }];
    const prisma = {
      secret: { findMany: vi.fn().mockResolvedValue(rows) },
    };
    const service = new AccountService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.listSecrets('user-1', 'secret-4', 2)).resolves.toEqual(
      {
        items: [
          { id: 'secret-3', hasPassphrase: false, recipientLocked: false },
          { id: 'secret-2', hasPassphrase: false, recipientLocked: false },
        ],
        nextCursor: 'secret-2',
      },
    );
    expect(prisma.secret.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ownerId: 'user-1' },
        cursor: { id: 'secret-4' },
        skip: 1,
        take: 3,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });

  it('returns protection flags without exposing secret authentication material', async () => {
    const prisma = {
      secret: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'secret-1',
          recoveryCount: 0,
          authHash: 'private-auth-hash',
          recipientEmailHash: 'private-email-hash',
        }),
      },
    };
    const service = new AccountService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.getSecret('user-1', 'secret-1')).resolves.toEqual({
      id: 'secret-1',
      recoveryCount: 0,
      hasPassphrase: true,
      recipientLocked: true,
    });
    expect(prisma.secret.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'secret-1', ownerId: 'user-1' },
        select: expect.objectContaining({
          authHash: true,
          recipientEmailHash: true,
          recoveryCount: true,
        }),
      }),
    );
  });

  it('allows three revalidated link recoveries, then locks and purges on the next attempt', async () => {
    const secret = {
      status: 'active',
      expiresAt: null,
      maxViews: 5,
      viewsUsed: 0,
      recoveryCount: 0,
      ciphertextRef: 'secrets/secret-1/ciphertext',
      files: [{ storageRef: 'secrets/secret-1/files/file-1' }],
    };
    const tx = {
      secret: {
        findFirst: vi.fn().mockImplementation(async () => ({ ...secret })),
        updateMany: vi.fn().mockImplementation(async ({ data }) => {
          if (data.recoveryCount) {
            secret.recoveryCount += data.recoveryCount.increment;
          } else {
            secret.status = data.status;
          }
          return { count: 1 };
        }),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn(
        async (callback: (transaction: never) => Promise<unknown>) =>
          callback(tx as never),
      ),
    };
    const storagePurge = { purgeSecret: vi.fn().mockResolvedValue(undefined) };
    const service = new AccountService(
      prisma as never,
      storagePurge as never,
      {} as never,
      {} as never,
    );

    await expect(service.recoverSecretLink('user-1', 'secret-1')).resolves.toEqual({
      remainingRecoveries: 2,
    });
    await expect(service.recoverSecretLink('user-1', 'secret-1')).resolves.toEqual({
      remainingRecoveries: 1,
    });
    await expect(service.recoverSecretLink('user-1', 'secret-1')).resolves.toEqual({
      remainingRecoveries: 0,
    });
    await expect(
      service.recoverSecretLink('user-1', 'secret-1'),
    ).rejects.toMatchObject({ status: 423 });

    expect(secret.recoveryCount).toBe(3);
    expect(secret.status).toBe('locked');
    expect(tx.auditEvent.create).toHaveBeenCalledWith({
      data: {
        eventType: 'secret_link_recovered',
        secretId: 'secret-1',
        actorId: 'user-1',
      },
    });
    expect(tx.auditEvent.create).toHaveBeenCalledWith({
      data: { eventType: 'locked', secretId: 'secret-1', actorId: 'user-1' },
    });
    expect(tx.auditEvent.create).toHaveBeenCalledTimes(4);
    expect(storagePurge.purgeSecret).toHaveBeenCalledWith('secret-1', [
      'secrets/secret-1/ciphertext',
      'secrets/secret-1/files/file-1',
    ]);
  });

  it('returns encrypted owner content without consuming a recipient view', async () => {
    const material = {
      ciphertext: 'encrypted-content',
      ciphertextRef: null,
      iv: 'initialization-vector',
      kdf: { algorithm: 'HKDF-SHA-256' },
      maxViews: 3,
      viewsUsed: 1,
    };
    const prisma = {
      secret: { findFirst: vi.fn().mockResolvedValue(material) },
      auditEvent: { create: vi.fn() },
    };
    const service = new AccountService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.revealOwnedSecret('user-1', 'secret-1'),
    ).resolves.toEqual({
      ciphertext: 'encrypted-content',
      iv: 'initialization-vector',
      kdf: { algorithm: 'HKDF-SHA-256' },
    });
    expect(prisma.secret.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'secret-1',
          ownerId: 'user-1',
          status: { in: ['active', 'partially_viewed'] },
        }),
      }),
    );
    expect(prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it('applies the plan history window when listing audit events', async () => {
    const prisma = {
      user: { findUnique: vi.fn().mockResolvedValue({ plan: 'pro' }) },
      auditEvent: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = new AccountService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.audit('user-1', undefined, 10);
    const query = prisma.auditEvent.findMany.mock.calls[0]?.[0];
    expect(query.where.actorId).toBe('user-1');
    expect(query.where.timestamp.gte).toBeInstanceOf(Date);
    expect(query.take).toBe(11);
  });

  it('merges partial notification preference updates with default values', async () => {
    const initialPreferences = {
      access_requested: { inApp: false, email: true },
    };
    const prisma = {
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ notificationPreferences: initialPreferences }),
        update: vi.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            notificationPreferences: data.notificationPreferences,
          }),
        ),
      },
    };
    const service = new AccountService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await service.updateNotificationPreferences('user-1', {
      access_requested: { inApp: true, email: false },
    });
    expect(result.access_requested).toEqual({ inApp: true, email: false });
    expect(result.secret_expiring).toEqual({ inApp: true, email: false });
  });

  it('blocks self-service deletion of staff accounts', async () => {
    const prisma = {
      user: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'staff-1',
          adminUser: { role: 'ADM' },
          secrets: [],
        }),
      },
    };
    const service = new AccountService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.deleteAccount('staff-1', 'staff-user'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('deletes user-owned data and transfers teams after removing the identity link', async () => {
    const now = new Date();
    const secrets = [
      {
        id: 'secret-1',
        ciphertextRef: 'secrets/secret-1/ciphertext',
        files: [{ storageRef: 'secrets/secret-1/files/file-1' }],
      },
    ];
    const prisma = {
      user: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'user-1',
          email: 'user@example.com',
          identitySubject: 'supabase-user-id',
          adminUser: null,
          secrets,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn(),
    };
    const tx = {
      team: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'team-1',
            createdBy: 'user-1',
            members: [
              { userId: 'user-1', role: 'owner', createdAt: now },
              { userId: 'user-2', role: 'member', createdAt: now },
            ],
          },
        ]),
        update: vi.fn(),
        delete: vi.fn(),
      },
      teamMember: { updateMany: vi.fn(), deleteMany: vi.fn() },
      secret: { deleteMany: vi.fn() },
      notification: { deleteMany: vi.fn() },
      apiKey: { deleteMany: vi.fn() },
      emailOtp: { deleteMany: vi.fn() },
      policy: { deleteMany: vi.fn() },
      teamInvitation: { deleteMany: vi.fn() },
      abuseReport: { updateMany: vi.fn() },
      auditEvent: { updateMany: vi.fn() },
      user: { update: vi.fn() },
    };
    prisma.$transaction.mockImplementation(
      async (callback: (transaction: never) => Promise<void>) =>
        callback(tx as never),
    );
    const storagePurge = { purgeSecret: vi.fn().mockResolvedValue(undefined) };
    const config = {
      get: vi.fn((key: string) =>
        key === 'AUTH_PROVIDER' ? 'supabase' : undefined,
      ),
    };
    const billing = {
      cancelSubscriptionsForAccountDeletion: vi
        .fn()
        .mockResolvedValue(undefined),
    };
    const deleteUser = vi.fn().mockResolvedValue({ error: null });
    const supabase = {
      getAdminClient: vi.fn().mockReturnValue({
        auth: { admin: { deleteUser } },
      }),
    };
    const service = new AccountService(
      prisma as never,
      storagePurge as never,
      config as never,
      billing as never,
      supabase as never,
    );

    await expect(service.deleteAccount('user-1')).resolves.toEqual({
      deleted: true,
    });

    expect(billing.cancelSubscriptionsForAccountDeletion).toHaveBeenCalledWith(
      'user-1',
    );
    expect(deleteUser).toHaveBeenCalledWith('supabase-user-id');
    expect(tx.teamMember.updateMany).toHaveBeenCalledWith({
      where: { teamId: 'team-1', userId: 'user-2' },
      data: { role: 'owner' },
    });
    expect(tx.team.update).toHaveBeenCalledWith({
      where: { id: 'team-1' },
      data: { createdBy: 'user-2' },
    });
    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1' },
        data: expect.objectContaining({
          email: 'deleted-user-1@deleted.invalid',
          identitySubject: null,
          plan: 'free',
          deletedAt: expect.any(Date),
        }),
      }),
    );
    expect(storagePurge.purgeSecret).toHaveBeenCalledWith('secret-1', [
      'secrets/secret-1/ciphertext',
      'secrets/secret-1/files/file-1',
    ]);
  });

  it('does not remove the application account when Supabase identity deletion fails', async () => {
    const prisma = {
      user: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'user-1',
          email: 'user@example.com',
          identitySubject: 'supabase-user-id',
          adminUser: null,
          secrets: [],
        }),
      },
      $transaction: vi.fn(),
    };
    const billing = {
      cancelSubscriptionsForAccountDeletion: vi
        .fn()
        .mockResolvedValue(undefined),
    };
    const deleteUser = vi
      .fn()
      .mockResolvedValue({ error: new Error('Supabase unavailable') });
    const supabase = {
      getAdminClient: vi.fn().mockReturnValue({
        auth: { admin: { deleteUser } },
      }),
    };
    const config = {
      get: vi.fn((key: string) =>
        key === 'AUTH_PROVIDER' ? 'supabase' : undefined,
      ),
    };
    const service = new AccountService(
      prisma as never,
      {} as never,
      config as never,
      billing as never,
      supabase as never,
    );

    await expect(
      service.deleteAccount('user-1'),
    ).rejects.toThrow('Unable to delete the Supabase account');

    expect(deleteUser).toHaveBeenCalledWith('supabase-user-id');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
