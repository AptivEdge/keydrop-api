import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { StoragePurgeService } from '../../storage/storage-purge.service';

@Injectable()
export class SecretCleanupCronService {
  private readonly logger = new Logger(SecretCleanupCronService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly storagePurge: StoragePurgeService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredSecrets(): Promise<void> {
    try {
      const secrets = await this.prisma.secret.findMany({
        where: { expiresAt: { lte: new Date() } },
        select: {
          id: true,
          ciphertextRef: true,
          files: { select: { storageRef: true } },
        },
      });

      if (secrets.length === 0) {
        this.logger.debug('No expired secrets to clean up');
        return;
      }
      for (const secret of secrets) {
        await this.storagePurge.purgeSecret(secret.id, [
          secret.ciphertextRef,
          ...secret.files.map((file) => file.storageRef),
        ]);
      }
      await this.prisma.secret.deleteMany({
        where: { id: { in: secrets.map((secret) => secret.id) } },
      });

      this.logger.log(
        `Cleaned up ${secrets.length} expired secrets`,
      );
    } catch (error: unknown) {
      this.logger.error(
        'Expired secret cleanup failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async retryStorageDeletion(): Promise<void> {
    try {
      await this.storagePurge.processRetries();
    } catch (error: unknown) {
      this.logger.error(
        'Storage deletion retry failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
