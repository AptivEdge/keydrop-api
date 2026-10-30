import { NotificationsCronService } from './notifications.cron.service.js';

describe('NotificationsCronService', () => {
  it('creates an idempotent notification for an expiring secret', async () => {
    const secret = {
      id: 'secret-1',
      label: 'Private note',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      owner: { id: 'user-1', notificationPreferences: {} },
    };
    const prisma = {
      secret: { findMany: vi.fn().mockResolvedValue([secret]) },
      notification: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = new NotificationsCronService(prisma as never, {} as never);

    await service.createSecretExpiryNotifications();

    expect(prisma.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          userId: 'user-1',
          secretId: 'secret-1',
          type: 'secret_expiring',
          dedupeKey: 'secret_expiring:secret-1',
          emailSentAt: expect.any(Date),
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('sends pending email notifications only when opted in', async () => {
    const prisma = {
      notification: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'notification-1',
            type: 'access_requested',
            emailAttempts: 0,
            user: {
              email: 'user@example.com',
              notificationPreferences: {
                access_requested: { inApp: true, email: true },
              },
            },
          },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const email = {
      sendNotificationEmail: vi.fn().mockResolvedValue(undefined),
    };
    const service = new NotificationsCronService(
      prisma as never,
      email as never,
    );

    await service.deliverPendingNotificationEmails();

    expect(email.sendNotificationEmail).toHaveBeenCalledWith(
      'user@example.com',
      'access_requested',
    );
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: 'notification-1', emailSentAt: null },
      data: { emailSentAt: expect.any(Date) },
    });
  });

  it('backs off and stops after five failed email attempts', async () => {
    const prisma = {
      notification: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'notification-1',
            type: 'access_requested',
            emailAttempts: 4,
            user: {
              email: 'user@example.com',
              notificationPreferences: {
                access_requested: { inApp: true, email: true },
              },
            },
          },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const email = {
      sendNotificationEmail: vi
        .fn()
        .mockRejectedValue(new Error('Email provider unavailable')),
    };
    const service = new NotificationsCronService(
      prisma as never,
      email as never,
    );

    await service.deliverPendingNotificationEmails();

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: 'notification-1', emailSentAt: null },
      data: {
        emailAttempts: 5,
        emailNextAttemptAt: expect.any(Date),
        emailSentAt: expect.any(Date),
      },
    });
  });
});
