-- AgentBazaar bridge: custodial Bazaar keys, PayPali-funded mandates, orders.

CREATE TYPE "BazaarOrderStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');

CREATE TABLE "BazaarPrincipal" (
    "ownerId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "encPrivateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BazaarPrincipal_pkey" PRIMARY KEY ("ownerId")
);

CREATE TABLE "BazaarAccount" (
    "agentId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "encPrivateKey" TEXT NOT NULL,
    "grantId" TEXT,
    "mandateId" TEXT,
    "mandateExpiresAt" TIMESTAMP(3),
    "budgetMinor" BIGINT NOT NULL DEFAULT 0,
    "capMinor" BIGINT NOT NULL DEFAULT 0,
    "minTier" INTEGER NOT NULL DEFAULT 1,
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BazaarAccount_pkey" PRIMARY KEY ("agentId")
);

CREATE TABLE "BazaarOrder" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "connectionId" TEXT,
    "solutionId" TEXT NOT NULL,
    "quoteId" TEXT,
    "receiptId" TEXT,
    "chargeId" TEXT,
    "stakeId" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" "BazaarOrderStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "receipt" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BazaarOrder_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BazaarOrder_connectionId_createdAt_idx" ON "BazaarOrder"("connectionId", "createdAt");
CREATE INDEX "BazaarOrder_agentId_createdAt_idx" ON "BazaarOrder"("agentId", "createdAt");
