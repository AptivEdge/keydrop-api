import { BadRequestException, ConflictException } from '@nestjs/common';
import { AdminModerationService } from './admin-moderation.service.js';

describe('AdminModerationService', () => {
  it('requires a resolution note before closing a report', async () => {
    const prisma = {
      abuseReport: {
        findUnique: vi.fn().mockResolvedValue({ id: 'report-id', status: 'pending' }),
      },
    };
    const service = new AdminModerationService(prisma as never);

    await expect(
      service.updateReport(
        'report-id',
        { status: 'resolved', reason: 'Policy review completed' },
        { userId: 'staff-id' } as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('records report changes and audit reasons in one transaction', async () => {
    const report = { id: 'report-id', status: 'resolved' };
    const transaction = {
      abuseReport: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue(report),
      },
      adminAuditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      abuseReport: {
        findUnique: vi.fn().mockResolvedValue({ id: 'report-id', status: 'pending' }),
      },
      adminUser: {
        findFirst: vi.fn().mockResolvedValue({ userId: 'assignee-id' }),
      },
      $transaction: vi.fn(
        async (operation: (tx: typeof transaction) => unknown) =>
          operation(transaction),
      ),
    };
    const service = new AdminModerationService(prisma as never);

    await expect(
      service.updateReport(
        'report-id',
        {
          status: 'resolved',
          assigneeId: 'assignee-id',
          reason: 'Confirmed policy violation',
          resolutionNote: 'Content has been removed and owner notified',
        },
        { userId: 'reviewer-id' } as never,
      ),
    ).resolves.toBe(report);

    expect(transaction.abuseReport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'report-id', status: { notIn: ['resolved', 'dismissed'] } },
      }),
    );
    expect(transaction.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'reviewer-id',
        action: 'abuse_report_updated',
        targetId: 'report-id',
        reason: 'Confirmed policy violation',
      }),
    });
  });

  it('prevents a requester from reviewing their own approval', async () => {
    const prisma = {
      adminApproval: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'approval-id',
          status: 'pending',
          requestedById: 'requester-id',
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
    };
    const service = new AdminModerationService(prisma as never);

    await expect(
      service.reviewApproval(
        'approval-id',
        { decision: 'approved', reason: 'Reviewed the submitted impact' },
        { userId: 'requester-id' } as never,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('expires stale approval requests before listing them', async () => {
    const prisma = {
      adminApproval: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    const service = new AdminModerationService(prisma as never);

    await expect(service.listApprovals()).resolves.toEqual([]);
    expect(prisma.adminApproval.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'pending', expiresAt: { lte: expect.any(Date) } },
        data: { status: 'expired' },
      }),
    );
  });
});
