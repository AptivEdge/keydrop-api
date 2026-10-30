-- CreateEnum
CREATE TYPE "EmailOtpPurpose" AS ENUM ('recipient_access', 'email_verification', 'password_reset');

-- AlterTable
ALTER TABLE "EmailOtp" ADD COLUMN     "identitySubject" TEXT,
ADD COLUMN     "purpose" "EmailOtpPurpose" NOT NULL DEFAULT 'recipient_access';

-- CreateIndex
CREATE INDEX "EmailOtp_email_purpose_createdAt_idx" ON "EmailOtp"("email", "purpose", "createdAt");
