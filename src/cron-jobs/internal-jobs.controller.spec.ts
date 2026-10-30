import { ConfigService } from '@nestjs/config';
import {
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InternalJobsController } from './internal-jobs.controller.js';

describe('InternalJobsController', () => {
  const token = 'a-long-test-job-token';

  function createController(lockAcquired = true) {
    const config = {
      get: vi.fn().mockReturnValue(token),
    };
    const queryRaw = vi
      .fn()
      .mockResolvedValue([{ acquired: lockAcquired }]);
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
        callback({ $queryRaw: queryRaw }),
      ),
    };
    const secretCleanup = {
      runExpiredSecretCleanup: vi.fn().mockResolvedValue(undefined),
      runStorageDeletionRetry: vi.fn().mockResolvedValue(undefined),
    };
    const emailOtpCleanup = {
      runExpiredOtpCleanup: vi.fn().mockResolvedValue(undefined),
    };
    const retentionCleanup = {
      runRetainedDataCleanup: vi.fn().mockResolvedValue(undefined),
    };
    const notifications = {
      createSecretExpiryNotifications: vi.fn().mockResolvedValue(undefined),
      deliverPendingNotificationEmails: vi.fn().mockResolvedValue(undefined),
    };
    const billingReconciliation = {
      runPastDueSubscriptionReconciliation: vi
        .fn()
        .mockResolvedValue(undefined),
      runProviderBillingReconciliation: vi.fn().mockResolvedValue(undefined),
    };
    const requestsCleanup = {
      runExpiredRequestCleanup: vi.fn().mockResolvedValue(undefined),
    };
    const rateLimitCleanup = {
      runExpiredBucketCleanup: vi.fn().mockResolvedValue(undefined),
    };

    return {
      controller: new InternalJobsController(
        config as unknown as ConfigService,
        prisma as never,
        secretCleanup as never,
        emailOtpCleanup as never,
        retentionCleanup as never,
        notifications as never,
        billingReconciliation as never,
        requestsCleanup as never,
        rateLimitCleanup as never,
      ),
      config,
      queryRaw,
      prisma,
      secretCleanup,
      emailOtpCleanup,
      retentionCleanup,
      notifications,
      billingReconciliation,
      requestsCleanup,
      rateLimitCleanup,
    };
  }

  it('executes an authorized job while holding its database lock', async () => {
    const { controller, queryRaw, secretCleanup } = createController();

    await expect(
      controller.run('secret-cleanup', `Bearer ${token}`),
    ).resolves.toEqual({ job: 'secret-cleanup', status: 'completed' });

    expect(queryRaw).toHaveBeenCalledOnce();
    expect(secretCleanup.runExpiredSecretCleanup).toHaveBeenCalledOnce();
  });

  it('skips a job that is already running', async () => {
    const { controller, secretCleanup } = createController(false);

    await expect(
      controller.run('secret-cleanup', `Bearer ${token}`),
    ).resolves.toEqual({ job: 'secret-cleanup', status: 'already_running' });
    expect(secretCleanup.runExpiredSecretCleanup).not.toHaveBeenCalled();
  });

  it('rejects requests without the configured bearer token', async () => {
    const { controller, prisma } = createController();

    await expect(
      controller.run('secret-cleanup', 'Bearer incorrect'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('fails closed when the internal token is not configured', async () => {
    const { controller, config, prisma } = createController();
    config.get.mockReturnValue(undefined);

    await expect(
      controller.run('secret-cleanup', `Bearer ${token}`),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects unknown scheduled job names', async () => {
    const { controller, prisma } = createController();

    await expect(
      controller.run('unknown', `Bearer ${token}`),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('propagates job failures so the request is not reported as successful', async () => {
    const { controller, secretCleanup } = createController();
    secretCleanup.runExpiredSecretCleanup.mockRejectedValue(
      new Error('storage operation failed'),
    );

    await expect(
      controller.run('secret-cleanup', `Bearer ${token}`),
    ).rejects.toThrow('storage operation failed');
  });
});
