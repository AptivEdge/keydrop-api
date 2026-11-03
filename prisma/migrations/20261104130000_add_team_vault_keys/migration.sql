ALTER TABLE "Secret"
ADD COLUMN "teamId" TEXT;

CREATE TABLE "UserEncryptionKey" (
    "userId" TEXT NOT NULL,
    "publicKey" JSONB NOT NULL,
    "encryptedPrivateKey" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserEncryptionKey_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "TeamSecretKey" (
    "secretId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamSecretKey_pkey" PRIMARY KEY ("secretId", "userId")
);

CREATE INDEX "Secret_teamId_createdAt_idx" ON "Secret"("teamId", "createdAt");
CREATE INDEX "TeamSecretKey_userId_createdAt_idx" ON "TeamSecretKey"("userId", "createdAt");

ALTER TABLE "Secret"
ADD CONSTRAINT "Secret_teamId_fkey"
FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserEncryptionKey"
ADD CONSTRAINT "UserEncryptionKey_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamSecretKey"
ADD CONSTRAINT "TeamSecretKey_secretId_fkey"
FOREIGN KEY ("secretId") REFERENCES "Secret"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "TeamSecretKey_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
