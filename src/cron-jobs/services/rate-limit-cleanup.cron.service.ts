import { Injectable, Logger } from '@nestjs/common';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service.js';

@Injectable()
export class RateLimitCleanupCronService {
  private readonly logger = new Logger(RateLimitCleanupCronService.name);

  constructor(private readonly rateLimit: RateLimitService) {}

  async runExpiredBucketCleanup(): Promise<void> {
    const count = await this.rateLimit.cleanupExpiredBuckets();
    if (count > 0) {
      this.logger.log(`Removed ${count} expired rate limit buckets`);
    }
  }
}
