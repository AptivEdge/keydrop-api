import { Injectable, OnModuleDestroy } from '@nestjs/common';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface Bucket {
  timestamps: number[];
  lastSeenAt: number;
}

const POLICIES: Record<
  import('./rate-limit.decorator.js').RateLimitPolicy,
  { limit: number; windowMs: number }
> = {
  secret_create: { limit: 20, windowMs: 60 * 60 * 1000 },
  secret_reveal: { limit: 30, windowMs: 10 * 60 * 1000 },
  secret_report: { limit: 10, windowMs: 60 * 60 * 1000 },
  team_invitation: { limit: 20, windowMs: 60 * 60 * 1000 },
  api_key_request: { limit: 10, windowMs: 60 * 60 * 1000 },
  checkout: { limit: 10, windowMs: 60 * 60 * 1000 },
  auth_signup: { limit: 5, windowMs: 60 * 60 * 1000 },
  auth_login: { limit: 10, windowMs: 15 * 60 * 1000 },
  auth_refresh: { limit: 30, windowMs: 60 * 60 * 1000 },
  otp_issue: { limit: 5, windowMs: 60 * 60 * 1000 },
  otp_verify: { limit: 10, windowMs: 15 * 60 * 1000 },
  password_reset: { limit: 5, windowMs: 60 * 60 * 1000 },
  recipient_access: { limit: 5, windowMs: 60 * 60 * 1000 },
  anonymous_secret_create: { limit: 3, windowMs: 60 * 60 * 1000 },
};

@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly buckets = new Map<string, Bucket>();
  private readonly cleanupTimer = setInterval(
    () => this.cleanup(),
    10 * 60 * 1000,
  );

  consume(
    policy: import('./rate-limit.decorator.js').RateLimitPolicy,
    key: string,
  ): RateLimitResult {
    const config = POLICIES[policy];
    const now = Date.now();
    const bucketKey = `${policy}:${key}`;
    const bucket = this.buckets.get(bucketKey) ?? {
      timestamps: [],
      lastSeenAt: now,
    };
    const cutoff = now - config.windowMs;
    bucket.timestamps = bucket.timestamps.filter(
      (timestamp) => timestamp > cutoff,
    );
    bucket.lastSeenAt = now;

    if (bucket.timestamps.length >= config.limit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.timestamps[0] + config.windowMs - now) / 1000),
      );
      this.buckets.set(bucketKey, bucket);
      return { allowed: false, retryAfterSeconds };
    }

    bucket.timestamps.push(now);
    this.buckets.set(bucketKey, bucket);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
    this.buckets.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      const policy = key.slice(0, key.indexOf(':')) as keyof typeof POLICIES;
      const cutoff = now - POLICIES[policy].windowMs;
      bucket.timestamps = bucket.timestamps.filter(
        (timestamp) => timestamp > cutoff,
      );
      if (
        !bucket.timestamps.length &&
        now - bucket.lastSeenAt > POLICIES[policy].windowMs
      ) {
        this.buckets.delete(key);
      }
    }
  }
}
