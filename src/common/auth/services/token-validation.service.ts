import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
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
  'custom:role'?: string;
  [key: string]: unknown;
}

type JwtVerifier = {
  verify(token: string): Promise<Record<string, unknown>>;
};

type CognitoPool = {
  name: string;
  userPoolId: string;
  clientId: string;
};

@Injectable()
export class TokenValidationService {
  private readonly logger = new Logger(TokenValidationService.name);
  private readonly idVerifiers: JwtVerifier[] = [];
  private readonly accessVerifiers: JwtVerifier[] = [];

  constructor(private readonly configService: ConfigService) {
    const pools = this.getConfiguredPools();
    if (pools.length === 0) {
      this.logger.warn(
        'Cognito is not configured. Set USER_COGNITO or ADMIN_COGNITO pool settings.',
      );
      return;
    }

    for (const pool of pools) {
      this.idVerifiers.push(
        CognitoJwtVerifier.create({
          userPoolId: pool.userPoolId,
          clientId: pool.clientId,
          tokenUse: 'id',
        }),
      );
      this.accessVerifiers.push(
        CognitoJwtVerifier.create({
          userPoolId: pool.userPoolId,
          clientId: pool.clientId,
          tokenUse: 'access',
        }),
      );
      this.logger.log(`Initialized Cognito verifier for ${pool.name} pool`);
    }
  }

  async validateToken(
    token: string,
    tokenType: 'id' | 'access' = 'id',
  ): Promise<TokenPayload & { userType: UserType; role: string }> {
    if (!token.trim()) {
      throw new UnauthorizedException('Token is required');
    }

    const verifiers =
      tokenType === 'id' ? this.idVerifiers : this.accessVerifiers;
    if (verifiers.length === 0) {
      throw new UnauthorizedException('Authentication is not configured');
    }

    for (const verifier of verifiers) {
      try {
        const payload = await verifier.verify(token);
        const normalized = this.normalizePayload(payload, tokenType);

        return {
          ...normalized,
          userType: UserType.USER,
          role: 'USER',
        };
      } catch {
        // A token can belong to any configured pool. Continue until one verifies it.
      }
    }

    this.logger.warn(`Cognito ${tokenType} token validation failed`);
    throw new UnauthorizedException('Invalid or expired authentication token');
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
          : typeof payload['cognito:username'] === 'string'
            ? payload['cognito:username']
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
    };
  }

  private getConfiguredPools(): CognitoPool[] {
    const poolPrefixes = ['USER', 'ADMIN'];
    return poolPrefixes.flatMap((prefix) => {
      const userPoolId = this.configService.get<string>(
        `${prefix}_COGNITO_USER_POOL_ID`,
      );
      const clientId = this.configService.get<string>(
        `${prefix}_COGNITO_CLIENT_ID`,
      );

      if (!userPoolId || !clientId) {
        return [];
      }

      return [{ name: prefix.toLowerCase(), userPoolId, clientId }];
    });
  }
}
