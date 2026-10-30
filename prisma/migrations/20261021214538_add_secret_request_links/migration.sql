-- CreateEnum
CREATE TYPE "RequestLinkStatus" AS ENUM ('pending', 'fulfilled', 'cancelled', 'expired');

-- CreateTable
CREATE TABLE "SecretRequestLink" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "recipientEmail" TEXT,
    "status" "RequestLinkStatus" NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "responseCiphertext" TEXT,
    "responseIv" TEXT,
    "responseSalt" TEXT,
    "responsePublicKey" TEXT,
    "fulfilledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecretRequestLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecretRequestLink_ownerId_createdAt_idx" ON "SecretRequestLink"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "SecretRequestLink_status_expiresAt_idx" ON "SecretRequestLink"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "SecretRequestLink" ADD CONSTRAINT "SecretRequestLink_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
