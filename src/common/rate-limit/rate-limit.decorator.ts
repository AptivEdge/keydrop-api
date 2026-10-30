import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'rate_limit';

export type RateLimitPolicy =
  | 'secret_create'
  | 'secret_reveal'
  | 'secret_report'
  | 'team_invitation'
  | 'api_key_request'
  | 'checkout'
  | 'auth_signup'
  | 'admin_bootstrap'
  | 'admin_account_create'
  | 'auth_login'
  | 'auth_refresh'
  | 'otp_issue'
  | 'otp_verify'
  | 'password_reset'
  | 'recipient_access'
  | 'anonymous_secret_create'
  | 'request_create'
  | 'request_respond';

export const RateLimit = (policy: RateLimitPolicy): MethodDecorator =>
  SetMetadata(RATE_LIMIT_KEY, policy);
