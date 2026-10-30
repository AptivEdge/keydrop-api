ALTER TYPE "SecretStatus" ADD VALUE IF NOT EXISTS 'partially_viewed';
ALTER TYPE "SecretStatus" ADD VALUE IF NOT EXISTS 'locked';

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'locked';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'email_code_sent';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'email_verified';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'email_code_failed';

ALTER TABLE "Secret"
  ALTER COLUMN "ciphertextRef" DROP NOT NULL,
  ALTER COLUMN "wrappedKey" DROP NOT NULL,
  ALTER COLUMN "salt" DROP NOT NULL,
  ADD COLUMN "ciphertext" TEXT,
  ADD COLUMN "kdf" JSONB,
  ADD COLUMN "recipientEmail" TEXT;

ALTER TABLE "EmailOtp" ADD COLUMN "secretId" TEXT;
CREATE INDEX "EmailOtp_secretId_createdAt_idx" ON "EmailOtp"("secretId", "createdAt");
ALTER TABLE "EmailOtp"
  ADD CONSTRAINT "EmailOtp_secretId_fkey"
  FOREIGN KEY ("secretId") REFERENCES "Secret"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
