import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service.js';

@Injectable()
export class RateLimitCleanupCronService {
  private readonly logger = new Logger(RateLimitCleanupCronService.name);

  constructor(private readonly rateLimit: RateLimitService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredBuckets(): Promise<void> {
    try {
      await this.runExpiredBucketCleanup();
    } catch (error: unknown) {
      this.logger.error(
        'Rate limit bucket cleanup failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async runExpiredBucketCleanup(): Promise<void> {
    const count = await this.rateLimit.cleanupExpiredBuckets();
    if (count > 0) {
      this.logger.log(`Removed ${count} expired rate limit buckets`);
    }
  }
}
