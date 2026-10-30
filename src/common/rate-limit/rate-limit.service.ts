import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RateLimitPolicy } from './rate-limit.decorator.js';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

const POLICIES: Record<RateLimitPolicy, { limit: number; windowMs: number }> = {
  secret_create: { limit: 20, windowMs: 60 * 60 * 1000 },
  secret_reveal: { limit: 30, windowMs: 10 * 60 * 1000 },
  secret_report: { limit: 10, windowMs: 60 * 60 * 1000 },
  team_invitation: { limit: 20, windowMs: 60 * 60 * 1000 },
  api_key_request: { limit: 10, windowMs: 60 * 60 * 1000 },
  checkout: { limit: 10, windowMs: 60 * 60 * 1000 },
  auth_signup: { limit: 10, windowMs: 60 * 60 * 1000 },
  admin_bootstrap: { limit: 3, windowMs: 60 * 60 * 1000 },
  admin_account_create: { limit: 10, windowMs: 60 * 60 * 1000 },
  auth_login: { limit: 10, windowMs: 15 * 60 * 1000 },
  auth_refresh: { limit: 30, windowMs: 60 * 60 * 1000 },
  otp_issue: { limit: 5, windowMs: 60 * 60 * 1000 },
  otp_verify: { limit: 10, windowMs: 15 * 60 * 1000 },
  password_reset: { limit: 5, windowMs: 60 * 60 * 1000 },
  recipient_access: { limit: 5, windowMs: 60 * 60 * 1000 },
  anonymous_secret_create: { limit: 3, windowMs: 60 * 60 * 1000 },
  request_create: { limit: 20, windowMs: 60 * 60 * 1000 },
  request_respond: { limit: 10, windowMs: 60 * 60 * 1000 },
};

const MAX_WINDOW_MS = Math.max(
  ...Object.values(POLICIES).map(({ windowMs }) => windowMs),
);

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async consume(
    policy: RateLimitPolicy,
    key: string,
  ): Promise<RateLimitResult> {
    const policyConfig = POLICIES[policy];
    const bucketKey = this.hashBucketKey(policy, key);
    return this.prisma.$transaction(
      async (transaction) => {
        await transaction.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${bucketKey}, 0)
          )::text AS locked
        `;
        const now = new Date();
        const cutoff = new Date(now.getTime() - policyConfig.windowMs);
        const bucket = await transaction.rateLimitBucket.findUnique({
          where: { bucketKey },
          select: { timestamps: true },
        });
        const timestamps = (bucket?.timestamps ?? [])
          .filter((timestamp) => timestamp > cutoff)
          .sort((left, right) => left.getTime() - right.getTime());
        const allowed = timestamps.length < policyConfig.limit;
        const retryAfterSeconds = allowed
          ? 0
          : Math.max(
              1,
              Math.ceil(
                (timestamps[0].getTime() +
                  policyConfig.windowMs -
                  now.getTime()) /
                  1000,
              ),
            );

        await transaction.rateLimitBucket.upsert({
          where: { bucketKey },
          create: {
            bucketKey,
            timestamps: allowed ? [...timestamps, now] : timestamps,
            lastSeenAt: now,
          },
          update: {
            timestamps: allowed ? [...timestamps, now] : timestamps,
            lastSeenAt: now,
          },
        });

        return { allowed, retryAfterSeconds };
      },
      { maxWait: 2_000, timeout: 5_000 },
    );
  }

  async cleanupExpiredBuckets(): Promise<number> {
    const cutoff = new Date(Date.now() - MAX_WINDOW_MS);
    const staleBuckets = await this.prisma.rateLimitBucket.findMany({
      where: { lastSeenAt: { lt: cutoff } },
      select: { bucketKey: true },
      take: 500,
      orderBy: { lastSeenAt: 'asc' },
    });
    if (staleBuckets.length === 0) return 0;

    const result = await this.prisma.rateLimitBucket.deleteMany({
      where: {
        bucketKey: { in: staleBuckets.map(({ bucketKey }) => bucketKey) },
        lastSeenAt: { lt: cutoff },
      },
    });
    return result.count;
  }

  private hashBucketKey(policy: RateLimitPolicy, key: string): string {
    const pepper = this.config.get<string>('SECRET_AUTH_PEPPER');
    if (!pepper) {
      this.logger.error(
        JSON.stringify({
          event: 'rate_limit_configuration_failure',
          reason: 'missing_secret_auth_pepper',
        }),
      );
      throw new ServiceUnavailableException('Rate limiting is not configured');
    }

    return createHmac('sha256', pepper)
      .update(`${policy}:${key}`)
      .digest('hex');
  }
}
