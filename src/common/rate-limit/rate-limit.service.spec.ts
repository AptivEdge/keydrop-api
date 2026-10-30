import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service.js';

describe('RateLimitService', () => {
  function createService() {
    const buckets = new Map<string, { timestamps: Date[] }>();
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      rateLimitBucket: {
        findUnique: vi.fn(({ where }: { where: { bucketKey: string } }) =>
          Promise.resolve(buckets.get(where.bucketKey) ?? null),
        ),
        upsert: vi.fn(
          ({
            where,
            create,
            update,
          }: {
            where: { bucketKey: string };
            create: { timestamps: Date[] };
            update: { timestamps: Date[] };
          }) => {
            buckets.set(where.bucketKey, {
              timestamps: [...(buckets.has(where.bucketKey) ? update : create).timestamps],
            });
            return Promise.resolve({});
          },
        ),
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const prisma = {
      $transaction: vi.fn((callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      rateLimitBucket: transaction.rateLimitBucket,
    };
    const config = {
      get: vi.fn().mockReturnValue('test-pepper'),
    };
    return {
      service: new RateLimitService(
        prisma as never,
        config as unknown as ConfigService,
      ),
      prisma,
      transaction,
      buckets,
      config,
    };
  }

  it('blocks requests after a policy window is exhausted', async () => {
    const { service, transaction } = createService();

    for (let index = 0; index < 20; index += 1) {
      await expect(
        service.consume('secret_create', 'user-1:127.0.0.1:device'),
      ).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    }

    const blocked = await service.consume(
      'secret_create',
      'user-1:127.0.0.1:device',
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(21);
    expect(transaction.$queryRaw.mock.calls[0]?.[0].join('')).toContain(
      '::text AS locked',
    );
  });

  it('keeps clients isolated by hashed bucket key', async () => {
    const { service } = createService();

    for (let index = 0; index < 20; index += 1) {
      await service.consume('secret_create', 'client-a');
    }

    expect((await service.consume('secret_create', 'client-a')).allowed).toBe(
      false,
    );
    expect((await service.consume('secret_create', 'client-b')).allowed).toBe(
      true,
    );
  });

  it('fails closed when the key hashing pepper is missing', async () => {
    const { service, config, prisma } = createService();
    const errorLog = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    config.get.mockReturnValue(undefined);

    await expect(service.consume('secret_create', 'client-a')).rejects.toThrow(
      'Rate limiting is not configured',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('"reason":"missing_secret_auth_pepper"'),
    );
  });
});
