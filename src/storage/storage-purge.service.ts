import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';

const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class StoragePurgeService {
  private readonly logger = new Logger(StoragePurgeService.name);
  private readonly s3?: S3Client;
  private readonly bucket?: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const region = config.get<string>('S3_REGION');
    this.bucket = config.get<string>('S3_BUCKET');
    if (region && this.bucket) {
      this.s3 = new S3Client({ region });
    }
  }

  async purgeSecret(secretId: string, storageRefs: string[]): Promise<void> {
    const refs = [...new Set(storageRefs.filter(Boolean))];
    if (!refs.length) return;
    if (!this.s3 || !this.bucket) {
      await this.queue(secretId, refs, 'S3 storage is not configured');
      return;
    }

    try {
      for (let index = 0; index < refs.length; index += 1000) {
        const result = await this.s3.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: {
              Objects: refs.slice(index, index + 1000).map((Key) => ({ Key })),
              Quiet: true,
            },
          }),
        );
        const failures = result.Errors ?? [];
        if (failures.length) {
          throw new Error(
            `S3 failed to delete ${failures.length} storage objects`,
          );
        }
      }
      await this.markDeleted(refs);
    } catch (error) {
      await this.queue(
        secretId,
        refs,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async processRetries(): Promise<void> {
    if (!this.s3 || !this.bucket) return;
    const pending = await this.prisma.storageDeletion.findMany({
      where: {
        deletedAt: null,
        nextRetryAt: { lte: new Date() },
      },
      select: { id: true, secretId: true, storageRef: true, attempts: true },
      take: 100,
      orderBy: { nextRetryAt: 'asc' },
    });
    for (const item of pending) {
      try {
        await this.s3.send(
          new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: item.storageRef,
          }),
        );
        await this.prisma.storageDeletion.update({
          where: { id: item.id },
          data: { deletedAt: new Date(), lastError: null },
        });
      } catch (error) {
        const attempts = item.attempts + 1;
        await this.prisma.storageDeletion.update({
          where: { id: item.id },
          data: {
            attempts,
            lastError: error instanceof Error ? error.message : String(error),
            nextRetryAt: new Date(
              Date.now() +
                Math.min(2 ** attempts * 60 * 1000, MAX_RETRY_DELAY_MS),
            ),
          },
        });
      }
    }
  }

  private async queue(
    secretId: string,
    refs: string[],
    error: string,
  ): Promise<void> {
    await this.prisma.$transaction(
      refs.map((storageRef) =>
        this.prisma.storageDeletion.upsert({
          where: { storageRef },
          create: {
            secretId,
            storageRef,
            attempts: 1,
            lastError: error,
            nextRetryAt: new Date(Date.now() + 60 * 1000),
          },
          update: {
            secretId,
            attempts: { increment: 1 },
            lastError: error,
            nextRetryAt: new Date(Date.now() + 60 * 1000),
            deletedAt: null,
          },
        }),
      ),
    );
    this.logger.error(`Queued ${refs.length} storage objects for retry: ${error}`);
  }

  private markDeleted(refs: string[]): Promise<unknown> {
    return this.prisma.storageDeletion.updateMany({
      where: { storageRef: { in: refs } },
      data: { deletedAt: new Date(), lastError: null },
    });
  }
}
