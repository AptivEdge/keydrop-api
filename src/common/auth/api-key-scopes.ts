import { SetMetadata } from '@nestjs/common';

export const API_KEY_SCOPES = [
  'secrets:read',
  'secrets:write',
  'account:read',
  'account:write',
  'billing:read',
  'billing:write',
  'teams:read',
  'teams:write',
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export const API_KEY_SCOPE_KEY = 'apiKeyScope';

export function isApiKeyScope(scope: string): scope is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(scope);
}

export const RequireApiKeyScope = (scope: ApiKeyScope) =>
  SetMetadata(API_KEY_SCOPE_KEY, scope);
