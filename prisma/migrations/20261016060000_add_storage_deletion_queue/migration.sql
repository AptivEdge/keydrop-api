CREATE TABLE "StorageDeletion" (
    "id" TEXT NOT NULL,
    "secretId" TEXT,
    "storageRef" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageDeletion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StorageDeletion_storageRef_key" ON "StorageDeletion"("storageRef");
CREATE INDEX "StorageDeletion_nextRetryAt_deletedAt_idx" ON "StorageDeletion"("nextRetryAt", "deletedAt");
CREATE INDEX "StorageDeletion_secretId_idx" ON "StorageDeletion"("secretId");
