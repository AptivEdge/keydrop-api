import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import { UserType } from '../../core/constants/app.constants.js';

export interface TokenPayload {
  sub: string;
  username?: string;
  email?: string;
  phone_number?: string;
  name?: string;
  iss: string;
  aud?: string;
  client_id?: string;
  exp: number;
  iat: number;
  token_use: 'access' | 'id';
  authProvider?: 'supabase';
  'custom:role'?: string;
  [key: string]: unknown;
}

@Injectable()
export class TokenValidationService {
  private readonly logger = new Logger(TokenValidationService.name);
  private readonly supabaseIssuer?: string;
  private readonly supabaseJwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly configService: ConfigService) {
    const supabaseUrl = this.configService
      .get<string>('SUPABASE_URL')
      ?.replace(/\/+$/, '');
    if (!supabaseUrl) {
      this.logger.warn(
        'Supabase Auth is configured but SUPABASE_URL is not configured.',
      );
      return;
    }
    this.supabaseIssuer = `${supabaseUrl}/auth/v1`;
    this.supabaseJwks = createRemoteJWKSet(
      new URL(`${this.supabaseIssuer}/.well-known/jwks.json`),
    );
    this.logger.log('Initialized Supabase JWT verifier');
  }

  async validateToken(
    token: string,
    tokenType: 'id' | 'access' = 'id',
  ): Promise<TokenPayload & { userType: UserType; role: string }> {
    if (!token.trim()) {
      throw new UnauthorizedException('Token is required');
    }
    return this.validateSupabaseToken(token, tokenType);
  }

  checkTokenExpiry(payload: TokenPayload) {
    const expiresInSeconds = payload.exp - Math.floor(Date.now() / 1000);
    return {
      isExpired: expiresInSeconds <= 0,
      isExpiringSoon: expiresInSeconds > 0 && expiresInSeconds <= 300,
      expiresInMinutes: Math.floor(expiresInSeconds / 60),
    };
  }

  private normalizePayload(
    payload: Record<string, unknown>,
    tokenType: 'id' | 'access',
    authProvider: 'supabase',
  ): TokenPayload {
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.iss !== 'string' ||
      typeof payload.exp !== 'number' ||
      typeof payload.iat !== 'number'
    ) {
      throw new UnauthorizedException('Authentication token is malformed');
    }

    return {
      ...payload,
      sub: payload.sub,
      username:
        typeof payload.username === 'string'
          ? payload.username
          : payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      phone_number:
        typeof payload.phone_number === 'string'
          ? payload.phone_number
          : undefined,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      iss: payload.iss,
      aud: typeof payload.aud === 'string' ? payload.aud : undefined,
      client_id:
        typeof payload.client_id === 'string' ? payload.client_id : undefined,
      exp: payload.exp,
      iat: payload.iat,
      token_use: tokenType,
      authProvider,
    };
  }

  private async validateSupabaseToken(
    token: string,
    tokenType: 'id' | 'access',
  ): Promise<TokenPayload & { userType: UserType; role: string }> {
    if (!this.supabaseJwks || !this.supabaseIssuer) {
      throw new UnauthorizedException('Authentication is not configured');
    }

    try {
      const { payload } = await jwtVerify(token, this.supabaseJwks, {
        issuer: this.supabaseIssuer,
        audience: 'authenticated',
      });
      const normalized = this.normalizePayload(payload, tokenType, 'supabase');
      return {
        ...normalized,
        userType: UserType.USER,
        role: 'USER',
      };
    } catch (error) {
      if (
        error instanceof joseErrors.JOSEError &&
        error.code !== 'ERR_JWKS_TIMEOUT'
      ) {
        this.logger.warn('Supabase JWT validation failed');
        throw new UnauthorizedException(
          'Invalid or expired authentication token',
        );
      }
      this.logger.error('Supabase JWT signing keys could not be retrieved');
      throw new ServiceUnavailableException(
        'Authentication provider is temporarily unavailable',
      );
    }
  }
}
