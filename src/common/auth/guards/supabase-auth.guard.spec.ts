import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SupabaseAuthGuard } from './supabase-auth.guard.js';
import { OPTIONAL_AUTH_KEY } from '../decorators/optional-auth.decorator.js';

describe('SupabaseAuthGuard', () => {
  const token = `kd_${'x'.repeat(32)}`;
  const now = new Date();

  function createGuard(
    scope?: string,
    overrides: Record<string, unknown> = {},
  ) {
    const prisma = {
      adminBlocklistEntry: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      apiKey: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'key-1',
          userId: 'user-1',
          scopes: ['secrets:read'],
          expiresAt: null,
          revokedAt: null,
          user: {
            email: 'user@example.com',
            plan: 'pro',
            identitySubject: 'supabase-sub',
            deletedAt: null,
          },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      ...overrides,
    };
    const reflector = {
      getAllAndOverride: vi.fn((key: string) =>
        key === 'apiKeyScope' ? scope : false,
      ),
    };
    const guard = new SupabaseAuthGuard(
      { validateToken: vi.fn() } as never,
      reflector as never,
      prisma as never,
    );
    const request = {
      headers: { authorization: `Bearer ${token}` },
      method: 'GET',
      url: '/api/v1/me/secrets',
    };
    const context = {
      getHandler: vi.fn(),
      getClass: vi.fn(),
      switchToHttp: () => ({ getRequest: () => request }),
    };
    return { guard, prisma, request, context };
  }

  it('authenticates scoped keys and updates lastUsedAt', async () => {
    const { guard, prisma, request, context } = createGuard('secrets:read');

    await expect(guard.canActivate(context as never)).resolves.toBe(true);
    expect(prisma.apiKey.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          keyHash: createHash('sha256').update(token).digest('hex'),
        },
      }),
    );
    expect(prisma.apiKey.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'key-1',
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        },
        data: { lastUsedAt: expect.any(Date) },
      }),
    );
    expect(request).toHaveProperty('user.authMethod', 'api-key');
    expect(request).toHaveProperty('user.userId', 'user-1');
  });

  it('denies API keys belonging to an actively blocklisted account', async () => {
    const { guard, context } = createGuard('secrets:read', {
      adminBlocklistEntry: {
        findFirst: vi.fn().mockResolvedValue({ id: 'blocklist-entry' }),
      },
    });

    await expect(guard.canActivate(context as never))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  describe('SupabaseAuthGuard admin authorization', () => {
    function createStaffGuard(assuranceLevel: string, staff = true) {
      const tokenPayload = {
        sub: 'staff-sub',
        iss: 'https://example.supabase.co/auth/v1',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        token_use: 'id' as const,
        aal: assuranceLevel,
      };
      const tokenValidation = {
        validateToken: vi.fn().mockResolvedValue(tokenPayload),
        checkTokenExpiry: vi.fn().mockReturnValue({ isExpired: false }),
      };
      const prisma = {
        adminBlocklistEntry: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        user: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'staff-1',
            email: 'staff@example.com',
            plan: 'free',
            adminUser: staff ? { role: 'ADM' } : null,
          }),
        },
      };
      const reflector = { getAllAndOverride: vi.fn().mockReturnValue(undefined) };
      const guard = new SupabaseAuthGuard(
        tokenValidation as never,
        reflector as never,
        prisma as never,
      );
      const request = {
        headers: { authorization: 'Bearer staff-token' },
        method: 'GET',
        url: '/api/v1/users/me',
      };
      const context = {
        getHandler: vi.fn(),
        getClass: vi.fn(),
        switchToHttp: () => ({ getRequest: () => request }),
      };
      return { guard, request, context };
    }

    it.each(['production', 'staging', 'dev', 'development'])(
      'allows %s admin sessions authenticated with a valid token',
      async (environment) => {
        vi.stubEnv('NODE_ENV', environment);
        try {
          const { guard, context } = createStaffGuard('aal1');
          await expect(guard.canActivate(context as never)).resolves.toBe(true);
        } finally {
          vi.unstubAllEnvs();
        }
      },
    );

    it('allows customer sessions regardless of assurance level', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      try {
        const { guard, request, context } = createStaffGuard('aal1', false);
        await expect(guard.canActivate(context as never)).resolves.toBe(true);
        expect(request).toHaveProperty('user.role', 'USER');
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it('allows requests without a bearer token on optional-auth routes', async () => {
    const reflector = {
      getAllAndOverride: vi.fn((key: string) =>
        key === OPTIONAL_AUTH_KEY ? true : false,
      ),
    };
    const guard = new SupabaseAuthGuard(
      { validateToken: vi.fn() } as never,
      reflector as never,
      {} as never,
    );
    const context = {
      getHandler: vi.fn(),
      getClass: vi.fn(),
      switchToHttp: () => ({
        getRequest: () => ({ headers: {}, method: 'POST', url: '/api/v1/secrets' }),
      }),
    };

    await expect(guard.canActivate(context as never)).resolves.toBe(true);
  });

  it('denies keys without the route-required scope', async () => {
    const { guard, prisma, context } = createGuard('billing:read');

    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.apiKey.updateMany).not.toHaveBeenCalled();
  });

  it('denies API keys when a route has no explicit scope', async () => {
    const { guard, prisma, context } = createGuard();

    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.apiKey.updateMany).not.toHaveBeenCalled();
  });

  it('rejects revoked, expired, or Free-plan keys', async () => {
    const fixtures = [
      { revokedAt: now, expiresAt: null, plan: 'pro' },
      {
        revokedAt: null,
        expiresAt: new Date(now.getTime() - 1000),
        plan: 'pro',
      },
      { revokedAt: null, expiresAt: null, plan: 'free' },
    ];
    for (const fixture of fixtures) {
      const { guard, context } = createGuard('secrets:read', {
        apiKey: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'key-1',
            userId: 'user-1',
            scopes: ['secrets:read'],
            expiresAt: fixture.expiresAt,
            revokedAt: fixture.revokedAt,
            user: {
              email: 'user@example.com',
              plan: fixture.plan,
              identitySubject: 'supabase-sub',
              deletedAt: null,
            },
          }),
        },
      });
      await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
  });
});
