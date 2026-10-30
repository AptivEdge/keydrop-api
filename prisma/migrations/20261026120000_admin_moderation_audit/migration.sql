ALTER TABLE "User"
ADD COLUMN "suspendedAt" TIMESTAMP(3),
ADD COLUMN "suspensionReason" TEXT;

ALTER TABLE "AbuseReport"
ADD COLUMN "severity" TEXT NOT NULL DEFAULT 'normal',
ADD COLUMN "assigneeId" TEXT,
ADD COLUMN "resolutionNote" TEXT;

CREATE TYPE "AdminApprovalStatus" AS ENUM ('pending', 'approved', 'rejected', 'expired');

CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminApproval" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "status" "AdminApprovalStatus" NOT NULL DEFAULT 'pending',
    "requestedById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminApproval_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");
CREATE INDEX "AdminAuditLog_actorId_createdAt_idx" ON "AdminAuditLog"("actorId", "createdAt");
CREATE INDEX "AdminAuditLog_targetType_targetId_createdAt_idx" ON "AdminAuditLog"("targetType", "targetId", "createdAt");
CREATE INDEX "AdminApproval_status_expiresAt_idx" ON "AdminApproval"("status", "expiresAt");
CREATE INDEX "AdminApproval_requestedById_createdAt_idx" ON "AdminApproval"("requestedById", "createdAt");

ALTER TABLE "AdminAuditLog"
ADD CONSTRAINT "AdminAuditLog_actorId_fkey"
FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_admin_audit_log_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Admin audit records are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AdminAuditLog_append_only"
BEFORE UPDATE OR DELETE ON "AdminAuditLog"
FOR EACH ROW EXECUTE FUNCTION reject_admin_audit_log_mutation();

ALTER TABLE "AdminApproval"
ADD CONSTRAINT "AdminApproval_requestedById_fkey"
FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "AdminApproval_reviewedById_fkey"
FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
