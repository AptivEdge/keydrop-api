import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { SecretCleanupCronService } from '../src/cron-jobs/services/secret-cleanup.cron.service.js';
import { StoragePurgeService } from '../src/storage/storage-purge.service.js';

describe('Storage cleanup and retries (e2e)', () => {
  const secretId = 'expired-secret';
  const storageRefs = ['secrets/expired-secret/ciphertext', 'secrets/expired-secret/file'];
  const bucket = 'keydrop-test-bucket';
  let prisma: ReturnType<typeof createPrisma>;
  let send: ReturnType<typeof vi.spyOn>;
  let storagePurge: StoragePurgeService;
  let cleanup: SecretCleanupCronService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T00:00:00.000Z'));
    prisma = createPrisma(secretId, storageRefs);
    send = vi.spyOn(S3Client.prototype, 'send');
    storagePurge = new StoragePurgeService(
      prisma as never,
      { get: (key: string) => (key === 'S3_REGION' ? 'us-east-1' : bucket) } as never,
    );
    cleanup = new SecretCleanupCronService(
      prisma as never,
      storagePurge,
    );
  });

  afterEach(() => {
    send?.mockRestore();
    vi.useRealTimers();
  });

  it('queues failed purges, backs off failed retries, and records eventual deletion', async () => {
    send.mockResolvedValueOnce({
      Errors: [{ Key: storageRefs[0], Code: 'InternalError' }],
    } as never);

    await cleanup.cleanupExpiredSecrets();

    expect(prisma.secret.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [secretId] } },
    });
    expect(send).toHaveBeenCalledTimes(1);
    const bulkCommand = send.mock.calls[0][0];
    expect(bulkCommand).toBeInstanceOf(DeleteObjectsCommand);
    expect((bulkCommand as DeleteObjectsCommand).input).toEqual({
      Bucket: bucket,
      Delete: {
        Objects: storageRefs.map((Key) => ({ Key })),
        Quiet: true,
      },
    });
    expect([...prisma.deletions.values()]).toHaveLength(2);
    for (const deletion of prisma.deletions.values()) {
      expect(deletion).toEqual(
        expect.objectContaining({
          secretId,
          attempts: 1,
          lastError: 'S3 failed to delete 1 storage objects',
          nextRetryAt: new Date('2026-10-16T00:01:00.000Z'),
          deletedAt: null,
        }),
      );
    }

    vi.advanceTimersByTime(60_000);
    send.mockRejectedValueOnce(new Error('S3 temporarily unavailable'));
    send.mockRejectedValueOnce(new Error('S3 temporarily unavailable'));
    await cleanup.retryStorageDeletion();

    for (const deletion of prisma.deletions.values()) {
      expect(deletion).toEqual(
        expect.objectContaining({
          attempts: 2,
          lastError: 'S3 temporarily unavailable',
          nextRetryAt: new Date('2026-10-16T00:05:00.000Z'),
          deletedAt: null,
        }),
      );
    }

    vi.advanceTimersByTime(4 * 60_000);
    send.mockResolvedValue({});
    await cleanup.retryStorageDeletion();

    expect(send).toHaveBeenCalledTimes(5);
    for (const deletion of prisma.deletions.values()) {
      expect(deletion).toEqual(
        expect.objectContaining({
          attempts: 2,
          lastError: null,
          deletedAt: new Date('2026-10-16T00:05:00.000Z'),
        }),
      );
    }
    for (const [index, call] of send.mock.calls.slice(3).entries()) {
      expect(call[0]).toBeInstanceOf(DeleteObjectCommand);
      expect((call[0] as DeleteObjectCommand).input).toEqual({
        Bucket: bucket,
        Key: storageRefs[index],
      });
    }
  });
});

function createPrisma(secretId: string, storageRefs: string[]) {
  const deletions = new Map<
    string,
    {
      id: string;
      secretId: string | null;
      storageRef: string;
      attempts: number;
      nextRetryAt: Date;
      lastError: string | null;
      deletedAt: Date | null;
    }
  >();
  let nextId = 0;
  const storageDeletion = {
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { storageRef: string };
        create: {
          secretId: string;
          storageRef: string;
          attempts: number;
          nextRetryAt: Date;
          lastError: string;
        };
        update: {
          secretId: string;
          attempts: { increment: number };
          nextRetryAt: Date;
          lastError: string;
          deletedAt: null;
        };
      }) => {
        const existing = deletions.get(where.storageRef);
        if (existing) {
          Object.assign(existing, {
            secretId: update.secretId,
            attempts: existing.attempts + update.attempts.increment,
            nextRetryAt: update.nextRetryAt,
            lastError: update.lastError,
            deletedAt: update.deletedAt,
          });
          return existing;
        }
        const record = {
          id: `deletion-${++nextId}`,
          ...create,
          deletedAt: null,
        };
        deletions.set(record.storageRef, record);
        return record;
      },
    ),
    findMany: vi.fn(
      async ({
        where,
        take,
      }: {
        where: { deletedAt: null; nextRetryAt: { lte: Date } };
        take: number;
      }) =>
        [...deletions.values()]
          .filter(
            (deletion) =>
              deletion.deletedAt === null &&
              deletion.nextRetryAt <= where.nextRetryAt.lte,
          )
          .slice(0, take)
          .map(({ id, secretId, storageRef, attempts }) => ({
            id,
            secretId,
            storageRef,
            attempts,
          })),
    ),
    update: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: {
          deletedAt?: Date;
          lastError?: string | null;
          attempts?: number;
          nextRetryAt?: Date;
        };
      }) => {
        const record = [...deletions.values()].find(
          (deletion) => deletion.id === where.id,
        );
        if (!record) throw new Error(`Missing deletion record ${where.id}`);
        Object.assign(record, data);
        return record;
      },
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { storageRef: { in: string[] } };
        data: { deletedAt: Date; lastError: null };
      }) => {
        let count = 0;
        for (const deletion of deletions.values()) {
          if (where.storageRef.in.includes(deletion.storageRef)) {
            Object.assign(deletion, data);
            count += 1;
          }
        }
        return { count };
      },
    ),
  };

  return {
    deletions,
    storageDeletion,
    $transaction: vi.fn((operations: Promise<unknown>[]) =>
      Promise.all(operations),
    ),
    secret: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: secretId,
          ciphertextRef: storageRefs[0],
          files: [{ storageRef: storageRefs[1] }],
        },
      ]),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}
