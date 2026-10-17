import { AccountService } from './account.service.js';
import { ForbiddenException } from '@nestjs/common';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

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
        items: rows.slice(0, 2),
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

  it('deletes user-owned data and transfers teams after removing the Cognito identity', async () => {
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
    const cognitoSend = vi
      .spyOn(CognitoIdentityProviderClient.prototype, 'send')
      .mockResolvedValue({} as never);
    const storagePurge = { purgeSecret: vi.fn().mockResolvedValue(undefined) };
    const config = {
      get: vi.fn((key: string) =>
        key === 'USER_COGNITO_USER_POOL_ID'
          ? 'user-pool'
          : key === 'COGNITO_REGION'
            ? 'ap-south-1'
            : undefined,
      ),
    };
    const billing = {
      cancelSubscriptionsForAccountDeletion: vi
        .fn()
        .mockResolvedValue(undefined),
    };
    const service = new AccountService(
      prisma as never,
      storagePurge as never,
      config as never,
      billing as never,
    );

    await expect(
      service.deleteAccount('user-1', 'cognito-username'),
    ).resolves.toEqual({ deleted: true });

    expect(billing.cancelSubscriptionsForAccountDeletion).toHaveBeenCalledWith(
      'user-1',
    );
    expect(cognitoSend.mock.calls[0]?.[0].input).toEqual({
      UserPoolId: 'user-pool',
      Username: 'cognito-username',
    });
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
          cognitoSubject: null,
          plan: 'free',
          deletedAt: expect.any(Date),
        }),
      }),
    );
    expect(storagePurge.purgeSecret).toHaveBeenCalledWith('secret-1', [
      'secrets/secret-1/ciphertext',
      'secrets/secret-1/files/file-1',
    ]);
    cognitoSend.mockRestore();
  });
});
