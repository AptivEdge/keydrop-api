import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { StoragePurgeService } from '../../storage/storage-purge.service.js';

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
      await this.runExpiredSecretCleanup();
    } catch (error: unknown) {
      this.logger.error(
        'Expired secret cleanup failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async runExpiredSecretCleanup(): Promise<void> {
    const now = new Date();
    const secrets = await this.prisma.secret.findMany({
      where: {
        expiresAt: { lte: now },
        OR: [
          { status: { in: ['active', 'partially_viewed'] } },
          { ciphertext: { not: null } },
          { ciphertextRef: { not: null } },
          { authHash: { not: null } },
          { wrappedKey: { not: null } },
          { salt: { not: null } },
          { files: { some: {} } },
        ],
      },
      select: {
        id: true,
        ciphertextRef: true,
        files: { select: { storageRef: true } },
      },
      take: 100,
      orderBy: { expiresAt: 'asc' },
    });

    if (secrets.length === 0) {
      this.logger.debug('No expired secrets to clean up');
      return;
    }
    for (const secret of secrets) {
      await this.storagePurge.purgeSecret(secret.id, [
        secret.ciphertextRef,
        ...secret.files.map((file) => file.storageRef),
      ].filter((ref): ref is string => Boolean(ref)));
    }
    await this.prisma.$transaction(async (tx) => {
      const secretIds = secrets.map((secret) => secret.id);
      await tx.secret.updateMany({
        where: { id: { in: secretIds }, expiresAt: { lte: now } },
        data: {
          ciphertext: null,
          ciphertextRef: null,
          authHash: null,
          kdf: Prisma.DbNull,
          wrappedKey: null,
          salt: null,
        },
      });
      for (const secret of secrets) {
        const expired = await tx.secret.updateMany({
          where: {
            id: secret.id,
            expiresAt: { lte: now },
            status: { in: ['active', 'partially_viewed'] },
          },
          data: { status: 'expired' },
        });
        if (expired.count) {
          await tx.auditEvent.create({
            data: { eventType: 'secret_expired', secretId: secret.id },
          });
        }
      }
      await tx.file.deleteMany({ where: { secretId: { in: secretIds } } });
    });

    this.logger.log(`Purged content for ${secrets.length} expired secrets`);
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async retryStorageDeletion(): Promise<void> {
    try {
      await this.runStorageDeletionRetry();
    } catch (error: unknown) {
      this.logger.error(
        'Storage deletion retry failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async runStorageDeletionRetry(): Promise<void> {
    await this.storagePurge.processRetries();
  }
}
