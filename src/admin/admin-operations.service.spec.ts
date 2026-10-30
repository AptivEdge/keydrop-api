import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { AdminOperationsService } from './admin-operations.service.js';
import { UsersService } from '../users/controllers/users.service.js';

describe('AdminOperationsService', () => {
  it('records privacy-request intake and its audit event atomically', async () => {
    const result = { id: 'request-id', kind: 'export', status: 'received', dueAt: new Date() };
    const transaction = {
      adminDataRequest: { create: vi.fn().mockResolvedValue(result) },
      adminAuditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      user: { findUnique: vi.fn().mockResolvedValue({ id: 'user-id' }) },
      $transaction: vi.fn(async (operation: (tx: typeof transaction) => unknown) => operation(transaction)),
    };
    const service = new AdminOperationsService(prisma as never);

    await expect(service.createDataRequest(
      {
        userId: 'user-id',
        kind: 'export',
        reason: 'Customer requested a personal data export',
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      { userId: 'admin-id' } as never,
    )).resolves.toBe(result);
    expect(transaction.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'admin-id',
        action: 'data_request_created',
        targetId: 'request-id',
      }),
    });
  });

  it('rejects data-request status jumps', async () => {
    const prisma = {
      adminDataRequest: {
        findUnique: vi.fn().mockResolvedValue({ id: 'request-id', status: 'received' }),
      },
    };
    const service = new AdminOperationsService(prisma as never);

    await expect(service.updateDataRequest(
      'request-id',
      { status: 'completed', reason: 'Attempted to skip the verification process' },
      { userId: 'admin-id' } as never,
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it('requires future dates for data requests', async () => {
    const service = new AdminOperationsService({} as never);
    await expect(service.createDataRequest(
      {
        userId: 'user-id',
        kind: 'deletion',
        reason: 'Customer asked to delete their account',
        dueAt: new Date(Date.now() - 1_000).toISOString(),
      },
      { userId: 'admin-id' } as never,
    )).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not select secret contents or cryptographic material for lookup', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'secret-id',
      status: 'active',
      maxViews: 1,
      viewsUsed: 0,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      owner: null,
      _count: { abuseReports: 0 },
    });
    const service = new AdminOperationsService({ secret: { findUnique } } as never);

    await service.getSecretMetadata('secret-id');
    const selection = findUnique.mock.calls[0]?.[0]?.select;
    expect(selection).not.toHaveProperty('ciphertext');
    expect(selection).not.toHaveProperty('wrappedKey');
    expect(selection).not.toHaveProperty('label');
    expect(selection).not.toHaveProperty('recipientEmail');
  });

  it('prevents an active email-domain entry from authenticating an account', async () => {
    const prisma = {
      user: { findUnique: vi.fn().mockResolvedValue({ id: 'user-id' }) },
      adminBlocklistEntry: {
        findFirst: vi.fn().mockResolvedValue({ kind: 'email_domain' }),
      },
    };
    const service = new UsersService(prisma as never);

    await expect(service.assertNotBlocklisted('customer@example.com'))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not allow the sole Admin account to be blocklisted', async () => {
    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'admin-id',
          adminUser: { role: 'ADM' },
        }),
      },
    };
    const service = new AdminOperationsService(prisma as never);

    await expect(service.createBlocklistEntry(
      {
        kind: 'account',
        value: 'admin-id',
        reason: 'Restrict an administrative account immediately',
      },
      { userId: 'admin-id' } as never,
    )).rejects.toBeInstanceOf(BadRequestException);
  });
});
