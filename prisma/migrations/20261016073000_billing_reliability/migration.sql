ALTER TYPE "NotificationType" ADD VALUE 'billing_payment_failed';

CREATE TYPE "BillingInterval" AS ENUM ('monthly', 'yearly');

ALTER TABLE "Subscription"
ADD COLUMN "providerPlanId" TEXT,
ADD COLUMN "tier" "UserPlan" NOT NULL DEFAULT 'free',
ADD COLUMN "billingInterval" "BillingInterval",
ADD COLUMN "pendingTier" "UserPlan",
ADD COLUMN "pendingInterval" "BillingInterval",
ADD COLUMN "pendingProviderPlanId" TEXT,
ADD COLUMN "pastDueSince" TIMESTAMP(3),
ADD COLUMN "lastProviderEventAt" TIMESTAMP(3);

UPDATE "Subscription" AS subscription
SET "tier" = "User"."plan"
FROM "User"
WHERE "User"."id" = subscription."userId";

CREATE INDEX "Subscription_status_pastDueSince_idx"
ON "Subscription"("status", "pastDueSince");

ALTER TABLE "Invoice"
ADD COLUMN "paymentId" TEXT,
ADD COLUMN "providerUpdatedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Invoice_paymentId_key" ON "Invoice"("paymentId");

CREATE TABLE "BillingRefund" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "providerUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingRefund_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingRefund_externalId_key" ON "BillingRefund"("externalId");
CREATE INDEX "BillingRefund_userId_createdAt_idx" ON "BillingRefund"("userId", "createdAt");
CREATE INDEX "BillingRefund_paymentId_idx" ON "BillingRefund"("paymentId");

ALTER TABLE "BillingRefund"
ADD CONSTRAINT "BillingRefund_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
