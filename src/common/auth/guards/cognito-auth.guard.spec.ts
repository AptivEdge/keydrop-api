import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CognitoAuthGuard } from './cognito-auth.guard.js';

describe('CognitoAuthGuard API-key authentication', () => {
  const token = `kd_${'x'.repeat(32)}`;
  const now = new Date();

  function createGuard(
    scope?: string,
    overrides: Record<string, unknown> = {},
  ) {
    const prisma = {
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
            cognitoSubject: 'cognito-sub',
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
    const guard = new CognitoAuthGuard(
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
              cognitoSubject: 'cognito-sub',
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
