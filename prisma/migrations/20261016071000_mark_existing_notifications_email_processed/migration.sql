UPDATE "Notification"
SET "emailSentAt" = "createdAt"
WHERE "emailSentAt" IS NULL;
