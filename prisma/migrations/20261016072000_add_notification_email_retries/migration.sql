ALTER TABLE "Notification"
ADD COLUMN "emailAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "emailNextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "Notification_emailSentAt_emailNextAttemptAt_createdAt_idx"
ON "Notification"("emailSentAt", "emailNextAttemptAt", "createdAt");
