CREATE TABLE "BillingPlan" (
    "id" TEXT NOT NULL,
    "tier" "UserPlan" NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "providerPlanId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingPlan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingPlan_providerPlanId_key" ON "BillingPlan"("providerPlanId");
CREATE INDEX "BillingPlan_tier_interval_active_idx" ON "BillingPlan"("tier", "interval", "active");
CREATE INDEX "BillingPlan_createdAt_idx" ON "BillingPlan"("createdAt");
CREATE UNIQUE INDEX "BillingPlan_one_active_per_tier_interval_key"
ON "BillingPlan"("tier", "interval")
WHERE "active" = true;

ALTER TABLE "BillingPlan"
ADD CONSTRAINT "BillingPlan_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
