import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { UserType } from '../../core/constants/app.constants.js';
import {
  API_KEY_SCOPE_KEY,
  isApiKeyScope,
  type ApiKeyScope,
} from '../api-key-scopes.js';
import { AUTH_ROLES_KEY, IS_PUBLIC_KEY } from '../decorators/index.js';
import { OPTIONAL_AUTH_KEY } from '../decorators/optional-auth.decorator.js';
import {
  TokenPayload,
  TokenValidationService,
} from '../services/token-validation.service.js';

export interface AuthenticatedUser {
  id: string;
  sub: string;
  username: string;
  email?: string;
  phone_number?: string;
  name?: string;
  userType: UserType;
  role: string;
  plan: string;
  userId: string;
  tokenPayload: TokenPayload;
  authMethod?: 'supabase' | 'api-key';
  apiKeyScopes?: ApiKeyScope[];
}

type RequestWithUser = {
  headers: { authorization?: string };
  method: string;
  url: string;
  user?: AuthenticatedUser;
};

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(SupabaseAuthGuard.name);

  constructor(
    private readonly tokenValidationService: TokenValidationService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const isOptional = this.reflector.getAllAndOverride<boolean>(
      OPTIONAL_AUTH_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic && !isOptional) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (isOptional && !request.headers.authorization) {
      return true;
    }
    const token = this.extractBearerToken(request.headers.authorization);
    if (token.startsWith('kd_')) {
      return this.authenticateApiKey(token, context, request);
    }
    const tokenType = this.getTokenTypeForEndpoint(request.url);

    try {
      const payload = await this.tokenValidationService.validateToken(
        token,
        tokenType,
      );
      const expiry = this.tokenValidationService.checkTokenExpiry(payload);
      if (expiry.isExpired) {
        throw new UnauthorizedException('Token has expired');
      }

      const user = await this.findUser(payload);
      request.user = user;

      const requiredRoles = this.reflector.getAllAndOverride<string[]>(
        AUTH_ROLES_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (requiredRoles?.length && !this.hasRole(user.role, requiredRoles)) {
        throw new ForbiddenException('Insufficient permissions');
      }

      return true;
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }

      this.logger.warn(
        `Authentication failed for ${request.method} ${request.url}`,
      );
      throw new UnauthorizedException('Authentication failed');
    }
  }

  private async findUser(
    payload: TokenPayload & { userType: UserType; role: string },
  ): Promise<AuthenticatedUser> {
    const dbUser = await this.prisma.user.findUnique({
      where: { identitySubject: payload.sub },
      include: { adminUser: true },
    });

    if (!dbUser) {
      throw new UnauthorizedException('Authenticated user is not registered');
    }
    if (dbUser.suspendedAt) {
      throw new ForbiddenException('This account is suspended');
    }
    await this.assertNotBlocklisted(dbUser.email, dbUser.id);

    const role = dbUser.adminUser?.role ?? 'USER';
    return {
      id: dbUser.id,
      userId: dbUser.id,
      sub: payload.sub,
      username: payload.username ?? payload.sub,
      email: payload.email,
      phone_number: payload.phone_number,
      name: payload.name,
      userType: dbUser.adminUser ? UserType.ADMIN : UserType.USER,
      role,
      plan: dbUser.plan,
      tokenPayload: payload,
      authMethod: 'supabase',
    };
  }

  private async authenticateApiKey(
    token: string,
    context: ExecutionContext,
    request: RequestWithUser,
  ): Promise<boolean> {
    const keyHash = createHash('sha256').update(token).digest('hex');
    const apiKey = await this.prisma.apiKey.findUnique({
      where: { keyHash },
      select: {
        id: true,
        userId: true,
        scopes: true,
        expiresAt: true,
        revokedAt: true,
        user: {
          select: {
            email: true,
            plan: true,
            identitySubject: true,
            deletedAt: true,
            suspendedAt: true,
          },
        },
      },
    });
    const now = new Date();
    if (
      !apiKey ||
      apiKey.revokedAt ||
      (apiKey.expiresAt && apiKey.expiresAt <= now) ||
      apiKey.user.deletedAt ||
      apiKey.user.suspendedAt ||
      !['pro', 'team'].includes(apiKey.user.plan)
    ) {
      throw new UnauthorizedException('Invalid or expired API key');
    }
    await this.assertNotBlocklisted(apiKey.user.email, apiKey.userId);
    const scopes = apiKey.scopes.filter(isApiKeyScope);

    const requiredScope = this.reflector.getAllAndOverride<ApiKeyScope>(
      API_KEY_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredScope || !scopes.includes(requiredScope)) {
      throw new ForbiddenException('API key does not have the required scope');
    }
    const updated = await this.prisma.apiKey.updateMany({
      where: {
        id: apiKey.id,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      data: { lastUsedAt: now },
    });
    if (updated.count !== 1) {
      throw new UnauthorizedException('Invalid or expired API key');
    }

    const subject = apiKey.user.identitySubject ?? apiKey.userId;
    const timestamp = Math.floor(now.getTime() / 1000);
    request.user = {
      id: apiKey.userId,
      userId: apiKey.userId,
      sub: subject,
      username: apiKey.user.email,
      email: apiKey.user.email,
      userType: UserType.USER,
      role: 'USER',
      plan: apiKey.user.plan,
      authMethod: 'api-key',
      apiKeyScopes: scopes,
      tokenPayload: {
        sub: subject,
        username: apiKey.user.email,
        email: apiKey.user.email,
        iss: 'api-key',
        iat: timestamp,
        exp: timestamp,
        token_use: 'id',
      },
    };
    return true;
  }

  private extractBearerToken(header?: string): string {
    if (!header) {
      throw new UnauthorizedException('Authorization header is required');
    }

    const [scheme, token, ...extra] = header.trim().split(/\s+/);
    if (scheme?.toLowerCase() !== 'bearer' || !token || extra.length > 0) {
      throw new UnauthorizedException(
        'Authorization header must use the Bearer scheme',
      );
    }
    return token;
  }

  private getTokenTypeForEndpoint(url: string): 'id' | 'access' {
    return ['/logout', '/logout-all'].some((endpoint) =>
      url.split('?')[0].endsWith(endpoint),
    )
      ? 'access'
      : 'id';
  }

  private hasRole(userRole: string, requiredRoles: string[]): boolean {
    return requiredRoles.some(
      (requiredRole) => requiredRole.toUpperCase() === userRole.toUpperCase(),
    );
  }

  private async assertNotBlocklisted(email: string, userId: string) {
    const domain = email.trim().toLowerCase().split('@')[1];
    const entry = await this.prisma.adminBlocklistEntry.findFirst({
      where: {
        OR: [
          { kind: 'account', value: userId },
          { kind: 'email_domain', value: domain },
        ],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
      },
      select: { id: true },
    });
    if (entry) {
      throw new ForbiddenException('This account is blocked from Keydrop');
    }
  }
}
