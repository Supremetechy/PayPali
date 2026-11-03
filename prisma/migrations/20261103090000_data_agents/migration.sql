-- Data agents (company agents in front of their databases) and the mandate's explicit recurring switch.
ALTER TABLE "AgentConnection" ADD COLUMN "allowRecurring" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "DataAgentStatus" AS ENUM ('ACTIVE', 'PAUSED');
CREATE TYPE "DataQueryStatus" AS ENUM ('PENDING', 'ANSWERED', 'SETTLED', 'DISPUTED', 'REFUSED', 'FAILED');

CREATE TABLE "DataAgent" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "endpointUrl" TEXT NOT NULL,
    "endpointSecret" TEXT NOT NULL,
    "status" "DataAgentStatus" NOT NULL DEFAULT 'ACTIVE',
    "disputeWindowMs" INTEGER NOT NULL DEFAULT 86400000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DataAgent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DataAgent_slug_key" ON "DataAgent"("slug");
CREATE INDEX "DataAgent_ownerId_idx" ON "DataAgent"("ownerId");

CREATE TABLE "DataQuestionType" (
    "id" TEXT NOT NULL,
    "dataAgentId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "inputSchema" JSONB NOT NULL,
    "outputSchema" JSONB NOT NULL,
    "pricing" JSONB NOT NULL,
    "freshnessSeconds" INTEGER NOT NULL,
    "accuracyClaim" DOUBLE PRECISION NOT NULL,
    "privacy" JSONB NOT NULL,
    "allowedPurposes" TEXT[],
    "subjectQuery" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DataQuestionType_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DataQuestionType_dataAgentId_key_key" ON "DataQuestionType"("dataAgentId", "key");
ALTER TABLE "DataQuestionType" ADD CONSTRAINT "DataQuestionType_dataAgentId_fkey" FOREIGN KEY ("dataAgentId") REFERENCES "DataAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DataQuery" (
    "id" TEXT NOT NULL,
    "dataAgentId" TEXT NOT NULL,
    "questionTypeId" TEXT NOT NULL,
    "buyerAgentId" TEXT NOT NULL,
    "connectionId" TEXT,
    "subscriptionId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" "DataQueryStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "maxGas" INTEGER NOT NULL,
    "priceGas" INTEGER NOT NULL DEFAULT 0,
    "feeGas" INTEGER NOT NULL DEFAULT 0,
    "heldMinor" BIGINT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "sellerMinor" BIGINT NOT NULL DEFAULT 0,
    "feeMinor" BIGINT NOT NULL DEFAULT 0,
    "rowsScanned" INTEGER,
    "computeMs" INTEGER,
    "asOf" TIMESTAMP(3),
    "resultSha256" TEXT,
    "receipt" JSONB,
    "buyerStakeId" TEXT,
    "sellerStakeId" TEXT,
    "escrowTransferId" TEXT,
    "refundTransferId" TEXT,
    "batchId" TEXT,
    "subjectVerified" BOOLEAN NOT NULL DEFAULT false,
    "answeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DataQuery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DataQuery_buyerAgentId_idempotencyKey_key" ON "DataQuery"("buyerAgentId", "idempotencyKey");
CREATE INDEX "DataQuery_dataAgentId_status_answeredAt_idx" ON "DataQuery"("dataAgentId", "status", "answeredAt");
CREATE INDEX "DataQuery_connectionId_createdAt_idx" ON "DataQuery"("connectionId", "createdAt");
CREATE INDEX "DataQuery_subscriptionId_createdAt_idx" ON "DataQuery"("subscriptionId", "createdAt");

CREATE TABLE "DataSubscription" (
    "id" TEXT NOT NULL,
    "dataAgentId" TEXT NOT NULL,
    "buyerAgentId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "connectionId" TEXT,
    "monthlyBudgetMinor" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    CONSTRAINT "DataSubscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DataSubscription_dataAgentId_buyerAgentId_key" ON "DataSubscription"("dataAgentId", "buyerAgentId");

CREATE TABLE "DataSettlementBatch" (
    "id" TEXT NOT NULL,
    "dataAgentId" TEXT NOT NULL,
    "queryCount" INTEGER NOT NULL,
    "grossMinor" BIGINT NOT NULL,
    "feeMinor" BIGINT NOT NULL,
    "payouts" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DataSettlementBatch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DataSettlementBatch_dataAgentId_createdAt_idx" ON "DataSettlementBatch"("dataAgentId", "createdAt");

CREATE TABLE "DataSourceSplit" (
    "id" TEXT NOT NULL,
    "dataAgentId" TEXT NOT NULL,
    "payeeAgentId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "shareBps" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DataSourceSplit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DataSourceSplit_dataAgentId_payeeAgentId_key" ON "DataSourceSplit"("dataAgentId", "payeeAgentId");
