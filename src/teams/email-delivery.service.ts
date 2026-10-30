import { Injectable } from '@nestjs/common';
import type { NotificationType } from '../common/notifications/notification-preferences.js';
import type { EmailMessage } from '../email/email-provider.js';
import { EmailService } from '../email/email.service.js';

@Injectable()
export class EmailDeliveryService {
  constructor(private readonly email: EmailService) {}

  async sendTeamInvitation(
    recipient: string,
    teamName: string,
    inviteUrl: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.deliver({
      to: recipient,
      template: 'team_invitation',
      variables: {
        TEAM_NAME: teamName,
        INVITE_URL: inviteUrl,
        EXPIRES_AT: expiresAt.toISOString(),
      },
    });
  }

  async sendSecretRequestInvitation(
    recipient: string,
    title: string,
    requestUrl: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.deliver({
      to: recipient,
      template: 'secret_request',
      variables: {
        REQUEST_TITLE: title,
        REQUEST_URL: requestUrl,
        EXPIRES_AT: expiresAt.toISOString(),
      },
    });
  }

  async sendNotificationEmail(
    recipient: string,
    type: NotificationType,
  ): Promise<void> {
    const templates: Record<NotificationType, EmailMessage['template']> = {
      secret_created: 'notification_secret_created',
      secret_viewed: 'notification_secret_viewed',
      secret_expiring: 'notification_secret_expiring',
      secret_expired: 'notification_secret_expired',
      access_requested: 'notification_access_requested',
      access_granted: 'notification_access_granted',
      access_denied: 'notification_access_denied',
      billing_payment_failed: 'notification_billing_payment_failed',
    };
    await this.deliver({
      to: recipient,
      template: templates[type],
      variables: {},
    });
  }

  private async deliver(message: EmailMessage): Promise<void> {
    await this.email.send(message);
  }
}
