import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  EmailMessage,
  EmailProvider,
  EmailTemplateName,
} from './email-provider.js';

const templateConfigKeys: Record<EmailTemplateName, string> = {
  auth_verification: 'EMAIL_TEMPLATE_AUTH_VERIFICATION',
  password_reset: 'EMAIL_TEMPLATE_PASSWORD_RESET',
  recipient_access: 'EMAIL_TEMPLATE_RECIPIENT_ACCESS',
  team_invitation: 'EMAIL_TEMPLATE_TEAM_INVITATION',
  secret_request: 'EMAIL_TEMPLATE_SECRET_REQUEST',
  notification_secret_created: 'EMAIL_TEMPLATE_NOTIFICATION_SECRET_CREATED',
  notification_secret_viewed: 'EMAIL_TEMPLATE_NOTIFICATION_SECRET_VIEWED',
  notification_secret_expiring: 'EMAIL_TEMPLATE_NOTIFICATION_SECRET_EXPIRING',
  notification_secret_expired: 'EMAIL_TEMPLATE_NOTIFICATION_SECRET_EXPIRED',
  notification_access_requested: 'EMAIL_TEMPLATE_NOTIFICATION_ACCESS_REQUESTED',
  notification_access_granted: 'EMAIL_TEMPLATE_NOTIFICATION_ACCESS_GRANTED',
  notification_access_denied: 'EMAIL_TEMPLATE_NOTIFICATION_ACCESS_DENIED',
  notification_billing_payment_failed:
    'EMAIL_TEMPLATE_NOTIFICATION_BILLING_PAYMENT_FAILED',
};

export class ResendEmailProvider implements EmailProvider {
  private readonly logger = new Logger(ResendEmailProvider.name);

  constructor(private readonly config: ConfigService) {}

  async send(message: EmailMessage): Promise<void> {
    const apiKey = this.config.get<string>('EMAIL_API_KEY');
    const from = this.config.get<string>('EMAIL_FROM');
    if (!apiKey || !from) {
      throw new ServiceUnavailableException(
        'EMAIL_API_KEY and EMAIL_FROM are required for Resend',
      );
    }

    const templateConfigKey = templateConfigKeys[message.template];
    const templateId = this.config.get<string>(templateConfigKey)?.trim();
    if (!templateId) {
      throw new ServiceUnavailableException(
        `${templateConfigKey} is required to send this email`,
      );
    }

    let response: Response;
    try {
      response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          template: {
            id: templateId,
            variables: message.variables,
          },
        }),
      });
    } catch {
      this.logger.error('Resend request failed before a response was received');
      throw new ServiceUnavailableException(
        'Transactional email provider is unavailable',
      );
    }

    if (!response.ok) {
      const providerError = await readProviderError(response);
      const diagnostic = providerError
        ? ` name=${providerError.name ?? 'unknown'} message="${redactProviderMessage(
            providerError.message,
            [
              message.to,
              apiKey,
              ...Object.values(message.variables).map(String),
            ],
          )}"`
        : '';
      this.logger.error(
        `Resend rejected an email request with status ${response.status}${diagnostic}`,
      );
      throw new ServiceUnavailableException('Unable to deliver email');
    }
  }
}

async function readProviderError(
  response: Response,
): Promise<{ name?: string; message: string } | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;

    const name =
      'name' in body && typeof body.name === 'string'
        ? body.name.slice(0, 80)
        : undefined;
    const message =
      'message' in body && typeof body.message === 'string'
        ? body.message.slice(0, 1000)
        : undefined;
    return message ? { name, message } : null;
  } catch {
    return null;
  }
}

function redactProviderMessage(message: string, sensitiveValues: string[]) {
  let redacted = message;
  for (const value of sensitiveValues) {
    if (value.length >= 4) {
      redacted = redacted.replaceAll(value, '[REDACTED]');
    }
  }
  return redacted
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/[\r\n"]/g, ' ')
    .slice(0, 500);
}
