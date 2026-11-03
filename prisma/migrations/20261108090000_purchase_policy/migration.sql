-- Purchase policy: capture the full purchase context on each order and let owners
-- override the use-case taxonomy per agent (see src/bazaar/purchasePolicy).

ALTER TABLE "BazaarOrder" ADD COLUMN "category" TEXT;
ALTER TABLE "BazaarOrder" ADD COLUMN "permission" TEXT;
ALTER TABLE "BazaarOrder" ADD COLUMN "trigger" TEXT;
ALTER TABLE "BazaarOrder" ADD COLUMN "beneficiary" TEXT;
ALTER TABLE "BazaarOrder" ADD COLUMN "item" TEXT;
ALTER TABLE "BazaarOrder" ADD COLUMN "vendor" TEXT;
ALTER TABLE "BazaarOrder" ADD COLUMN "recurring" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BazaarOrder" ADD COLUMN "personalData" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BazaarOrder" ADD COLUMN "budgetOwner" TEXT;
ALTER TABLE "BazaarOrder" ADD COLUMN "onFailure" TEXT;

CREATE TABLE "AgentPurchasePolicy" (
    "agentId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "maxAmountMinor" BIGINT,
    "grantedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPurchasePolicy_pkey" PRIMARY KEY ("agentId", "category")
);
