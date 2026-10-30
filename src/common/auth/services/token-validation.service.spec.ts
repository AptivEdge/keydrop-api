import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { TokenValidationService } from './token-validation.service.js';

describe('TokenValidationService', () => {
  it('rejects malformed Supabase JWTs', async () => {
    const service = new TokenValidationService(
      new ConfigService({
        AUTH_PROVIDER: 'supabase',
        SUPABASE_URL: 'https://project.supabase.co',
      }),
    );

    await expect(service.validateToken('not-a-jwt')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('fails closed when Supabase Auth is selected without its URL', async () => {
    const service = new TokenValidationService(
      new ConfigService({ AUTH_PROVIDER: 'supabase' }),
    );

    await expect(service.validateToken('token')).rejects.toMatchObject({
      status: 401,
      message: 'Authentication is not configured',
    });
  });
});
