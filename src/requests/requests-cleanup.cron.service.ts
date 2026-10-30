import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RequestsService } from './requests.service.js';

@Injectable()
export class RequestsCleanupCronService {
  private readonly logger = new Logger(RequestsCleanupCronService.name);

  constructor(private readonly requests: RequestsService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async expireRequests(): Promise<void> {
    try {
      await this.runExpiredRequestCleanup();
    } catch (error) {
      this.logger.error(
        'Secret request cleanup failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async runExpiredRequestCleanup(): Promise<void> {
    const count = await this.requests.cleanupExpired();
    if (count > 0) {
      this.logger.log(`Expired ${count} secret requests and purged response ciphertext`);
    }
  }
}
