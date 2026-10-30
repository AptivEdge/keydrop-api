export const EMAIL_TEMPLATE_NAMES = [
  'auth_verification',
  'password_reset',
  'recipient_access',
  'team_invitation',
  'secret_request',
  'notification_secret_created',
  'notification_secret_viewed',
  'notification_secret_expiring',
  'notification_secret_expired',
  'notification_access_requested',
  'notification_access_granted',
  'notification_access_denied',
  'notification_billing_payment_failed',
] as const;

export type EmailTemplateName = (typeof EMAIL_TEMPLATE_NAMES)[number];

export interface EmailMessage {
  to: string;
  template: EmailTemplateName;
  variables: Record<string, string | number>;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}
