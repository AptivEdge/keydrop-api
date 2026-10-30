CREATE TYPE "AdminDataRequestKind" AS ENUM ('export', 'deletion');
CREATE TYPE "AdminDataRequestStatus" AS ENUM ('received', 'verifying', 'processing', 'completed', 'rejected');
CREATE TYPE "AdminBlocklistKind" AS ENUM ('account', 'email_domain');

CREATE TABLE "AdminDataRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "AdminDataRequestKind" NOT NULL,
    "status" "AdminDataRequestStatus" NOT NULL DEFAULT 'received',
    "reason" TEXT NOT NULL,
    "staffNote" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdminDataRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminBlocklistEntry" (
    "id" TEXT NOT NULL,
    "kind" "AdminBlocklistKind" NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminBlocklistEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminBlocklistEntry_kind_value_key" ON "AdminBlocklistEntry"("kind", "value");
CREATE INDEX "AdminBlocklistEntry_kind_expiresAt_idx" ON "AdminBlocklistEntry"("kind", "expiresAt");
CREATE INDEX "AdminDataRequest_status_dueAt_idx" ON "AdminDataRequest"("status", "dueAt");
CREATE INDEX "AdminDataRequest_userId_createdAt_idx" ON "AdminDataRequest"("userId", "createdAt");

ALTER TABLE "AdminDataRequest"
ADD CONSTRAINT "AdminDataRequest_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "AdminDataRequest_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AdminBlocklistEntry"
ADD CONSTRAINT "AdminBlocklistEntry_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
