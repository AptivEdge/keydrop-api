export const NOTIFICATION_TYPES = [
  'secret_created',
  'secret_viewed',
  'secret_expiring',
  'secret_expired',
  'access_requested',
  'access_granted',
  'access_denied',
  'billing_payment_failed',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type NotificationPreference = { inApp: boolean; email: boolean };
export type NotificationPreferences = Record<
  NotificationType,
  NotificationPreference
>;

export function defaultNotificationPreferences(): NotificationPreferences {
  return Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => [type, { inApp: true, email: false }]),
  ) as NotificationPreferences;
}

export function normalizeNotificationPreferences(
  value: unknown,
): NotificationPreferences {
  const defaults = defaultNotificationPreferences();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaults;
  }
  for (const type of NOTIFICATION_TYPES) {
    const preference = (value as Record<string, unknown>)[type];
    if (
      !preference ||
      typeof preference !== 'object' ||
      Array.isArray(preference)
    ) {
      continue;
    }
    const channels = preference as Record<string, unknown>;
    defaults[type] = {
      inApp: typeof channels.inApp === 'boolean' ? channels.inApp : true,
      email: typeof channels.email === 'boolean' ? channels.email : false,
    };
  }
  return defaults;
}
