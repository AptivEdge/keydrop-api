import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { NotificationType } from '../common/notifications/notification-preferences.js';

@Injectable()
export class EmailDeliveryService {
  private readonly logger = new Logger(EmailDeliveryService.name);
  private readonly client: SESv2Client;

  constructor(private readonly config: ConfigService) {
    this.client = new SESv2Client({
      region: this.config.get<string>('SES_REGION'),
    });
  }

  async sendTeamInvitation(
    recipient: string,
    teamName: string,
    inviteUrl: string,
    expiresAt: Date,
  ): Promise<void> {
    const from = this.config.get<string>('SES_FROM_EMAIL');
    if (!from) {
      throw new ServiceUnavailableException('SES_FROM_EMAIL is not configured');
    }
    try {
      await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: [recipient] },
          Content: {
            Simple: {
              Subject: { Data: `Invitation to join ${teamName}` },
              Body: {
                Text: {
                  Data: [
                    `You have been invited to join ${teamName} on Keydrop.`,
                    '',
                    `Accept the invitation: ${inviteUrl}`,
                    `This link expires on ${expiresAt.toISOString()}.`,
                  ].join('\n'),
                },
              },
            },
          },
        }),
      );
    } catch (error) {
      this.logger.error('Failed to send team invitation email', error);
      throw new ServiceUnavailableException(
        'Unable to deliver team invitation',
      );
    }
  }

  async sendNotificationEmail(
    recipient: string,
    type: NotificationType,
  ): Promise<void> {
    const from = this.config.get<string>('SES_FROM_EMAIL');
    if (!from) {
      throw new ServiceUnavailableException('SES_FROM_EMAIL is not configured');
    }
    const messages: Record<
      NotificationType,
      { subject: string; body: string }
    > = {
      secret_created: {
        subject: 'A Keydrop secret was created',
        body: 'A secret was created in your Keydrop account.',
      },
      secret_viewed: {
        subject: 'A Keydrop secret was viewed',
        body: 'One of your Keydrop secrets was viewed.',
      },
      secret_expiring: {
        subject: 'A Keydrop secret is expiring soon',
        body: 'One of your Keydrop secrets is scheduled to expire within 24 hours.',
      },
      secret_expired: {
        subject: 'A Keydrop secret expired',
        body: 'One of your Keydrop secrets has expired.',
      },
      access_requested: {
        subject: 'A Keydrop secret access was requested',
        body: 'Someone requested access to one of your Keydrop secrets.',
      },
      access_granted: {
        subject: 'A Keydrop secret request was approved',
        body: 'A request to access one of your Keydrop secrets was approved.',
      },
      access_denied: {
        subject: 'A Keydrop secret request was denied',
        body: 'A request to access one of your Keydrop secrets was denied.',
      },
      billing_payment_failed: {
        subject: 'Your Keydrop payment could not be processed',
        body: 'We could not process your subscription payment. Update your payment method in Razorpay to avoid interruption.',
      },
    };
    const message = messages[type];
    try {
      await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: [recipient] },
          Content: {
            Simple: {
              Subject: { Data: message.subject },
              Body: { Text: { Data: message.body } },
            },
          },
        }),
      );
    } catch (error) {
      this.logger.error('Failed to send notification email', error);
      throw new ServiceUnavailableException(
        'Unable to deliver notification email',
      );
    }
  }
}
