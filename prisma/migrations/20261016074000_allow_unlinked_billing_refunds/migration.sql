ALTER TABLE "BillingRefund"
DROP CONSTRAINT "BillingRefund_userId_fkey";

ALTER TABLE "BillingRefund"
ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "BillingRefund"
ADD CONSTRAINT "BillingRefund_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
