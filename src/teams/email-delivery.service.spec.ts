import { describe, expect, it, vi } from 'vitest';
import { EmailDeliveryService } from './email-delivery.service.js';

describe('EmailDeliveryService', () => {
  const expiresAt = new Date('2026-10-25T12:00:00.000Z');

  function createService() {
    const email = { send: vi.fn().mockResolvedValue(undefined) };
    return { service: new EmailDeliveryService(email as never), email };
  }

  it('sends team invitations with the published template and data variables', async () => {
    const { service, email } = createService();

    await service.sendTeamInvitation(
      'person@example.com',
      'Engineering',
      'https://keydrop.example/invite/token',
      expiresAt,
    );

    expect(email.send).toHaveBeenCalledWith({
      to: 'person@example.com',
      template: 'team_invitation',
      variables: {
        TEAM_NAME: 'Engineering',
        INVITE_URL: 'https://keydrop.example/invite/token',
        EXPIRES_AT: expiresAt.toISOString(),
      },
    });
  });

  it('sends secret requests through their own template', async () => {
    const { service, email } = createService();

    await service.sendSecretRequestInvitation(
      'person@example.com',
      'Deployment credentials',
      'https://keydrop.example/request/token',
      expiresAt,
    );

    expect(email.send).toHaveBeenCalledWith({
      to: 'person@example.com',
      template: 'secret_request',
      variables: {
        REQUEST_TITLE: 'Deployment credentials',
        REQUEST_URL: 'https://keydrop.example/request/token',
        EXPIRES_AT: expiresAt.toISOString(),
      },
    });
  });

  it.each([
    ['secret_created', 'notification_secret_created'],
    ['secret_viewed', 'notification_secret_viewed'],
    ['secret_expiring', 'notification_secret_expiring'],
    ['secret_expired', 'notification_secret_expired'],
    ['access_requested', 'notification_access_requested'],
    ['access_granted', 'notification_access_granted'],
    ['access_denied', 'notification_access_denied'],
    ['billing_payment_failed', 'notification_billing_payment_failed'],
  ] as const)(
    'routes the %s notification to its configurable template',
    async (notificationType, template) => {
      const { service, email } = createService();

      await service.sendNotificationEmail(
        'person@example.com',
        notificationType,
      );

      expect(email.send).toHaveBeenCalledWith({
        to: 'person@example.com',
        template,
        variables: {},
      });
    },
  );
});
