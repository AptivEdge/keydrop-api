import { Injectable, Logger } from '@nestjs/common';
import { RequestsService } from './requests.service.js';

@Injectable()
export class RequestsCleanupCronService {
  private readonly logger = new Logger(RequestsCleanupCronService.name);

  constructor(private readonly requests: RequestsService) {}

  async runExpiredRequestCleanup(): Promise<void> {
    const count = await this.requests.cleanupExpired();
    if (count > 0) {
      this.logger.log(`Expired ${count} secret requests and purged response ciphertext`);
    }
  }
}
