import { SetMetadata } from '@nestjs/common';

export const AUTH_ROLES_KEY = 'authRoles';
export const AuthRoles = (...roles: string[]) =>
  SetMetadata(AUTH_ROLES_KEY, roles);
