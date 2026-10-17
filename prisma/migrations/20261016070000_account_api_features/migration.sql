ALTER TABLE "ApiKey"
ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY['secrets:read']::TEXT[];

ALTER TABLE "User"
ADD COLUMN "notificationPreferences" JSONB NOT NULL DEFAULT '{}'::JSONB,
ADD COLUMN "deletedAt" TIMESTAMP(3);

ALTER TABLE "File"
ADD COLUMN "uploadedAt" TIMESTAMP(3);

ALTER TABLE "Notification"
ADD COLUMN "dedupeKey" TEXT,
ADD COLUMN "emailSentAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Notification_dedupeKey_key"
ON "Notification"("dedupeKey");
