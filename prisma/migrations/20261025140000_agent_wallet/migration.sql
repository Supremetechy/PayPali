-- Agent money movement: on-platform balances, ledger, and agent-to-agent transfers.

CREATE TYPE "LedgerDirection" AS ENUM ('CREDIT', 'DEBIT');
CREATE TYPE "LedgerEntryType" AS ENUM (
    'SEED_FUNDING', 'EXTERNAL_TOPUP', 'TRANSFER_IN', 'TRANSFER_OUT', 'SPEND', 'REFUND'
);
CREATE TYPE "TransferStatus" AS ENUM ('COMPLETED');

CREATE TABLE "AgentAccount" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "availableMinor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentAccount_agentId_currency_key" ON "AgentAccount"("agentId", "currency");

CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "balanceAfterMinor" BIGINT NOT NULL,
    "counterpartyAgentId" TEXT,
    "transferId" TEXT,
    "relatedIntentId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LedgerEntry_idempotencyKey_key" ON "LedgerEntry"("idempotencyKey");
CREATE INDEX "LedgerEntry_agentId_createdAt_idx" ON "LedgerEntry"("agentId", "createdAt");
CREATE INDEX "LedgerEntry_transferId_idx" ON "LedgerEntry"("transferId");

CREATE TABLE "AgentTransfer" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "fromAgentId" TEXT NOT NULL,
    "toAgentId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'COMPLETED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTransfer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentTransfer_idempotencyKey_key" ON "AgentTransfer"("idempotencyKey");
CREATE INDEX "AgentTransfer_fromAgentId_createdAt_idx" ON "AgentTransfer"("fromAgentId", "createdAt");
CREATE INDEX "AgentTransfer_toAgentId_createdAt_idx" ON "AgentTransfer"("toAgentId", "createdAt");

ALTER TABLE "AgentAccount"
ADD CONSTRAINT "AgentAccount_agentId_fkey"
FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LedgerEntry"
ADD CONSTRAINT "LedgerEntry_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "AgentAccount"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
