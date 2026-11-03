-- Agent Connect (external agents over remote MCP, bearer + OAuth 2.1) and the
-- Gas-priced service marketplace.

CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "ConnectionAuth" AS ENUM ('TOKEN', 'OAUTH');
CREATE TYPE "ConnectionTokenKind" AS ENUM ('ACCESS', 'REFRESH');
CREATE TYPE "ServiceOrderStatus" AS ENUM ('PROCESSING', 'FULFILLED', 'PENDING_PROVIDER', 'FAILED');

CREATE TABLE "AgentConnection" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "auth" "ConnectionAuth" NOT NULL,
    "oauthClientId" TEXT,
    "scopes" TEXT[],
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "maxPerTxMinor" BIGINT NOT NULL,
    "maxDailyMinor" BIGINT NOT NULL,
    "approvalAboveMinor" BIGINT,
    "allowedServices" TEXT[],
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentConnection_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgentConnection_agentId_idx" ON "AgentConnection"("agentId");
CREATE INDEX "AgentConnection_ownerId_idx" ON "AgentConnection"("ownerId");

CREATE TABLE "ConnectionToken" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "kind" "ConnectionTokenKind" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectionToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ConnectionToken_tokenHash_key" ON "ConnectionToken"("tokenHash");
CREATE INDEX "ConnectionToken_connectionId_idx" ON "ConnectionToken"("connectionId");

CREATE TABLE "OAuthClient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthClient_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OAuthCode" (
    "codeHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthCode_pkey" PRIMARY KEY ("codeHash")
);

CREATE TABLE "GasQuote" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "connectionId" TEXT,
    "serviceId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "gasUnits" INTEGER NOT NULL,
    "feeGas" INTEGER NOT NULL,
    "gasPriceMilli" INTEGER NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GasQuote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "GasQuote_agentId_idx" ON "GasQuote"("agentId");

CREATE TABLE "ServiceOrder" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "connectionId" TEXT,
    "serviceId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "gasUnits" INTEGER NOT NULL,
    "feeGas" INTEGER NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" "ServiceOrderStatus" NOT NULL DEFAULT 'PROCESSING',
    "reason" TEXT,
    "stakeId" TEXT,
    "transferId" TEXT,
    "refundId" TEXT,
    "fulfillment" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceOrder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ServiceOrder_quoteId_key" ON "ServiceOrder"("quoteId");
CREATE INDEX "ServiceOrder_connectionId_createdAt_idx" ON "ServiceOrder"("connectionId", "createdAt");
CREATE INDEX "ServiceOrder_agentId_createdAt_idx" ON "ServiceOrder"("agentId", "createdAt");

ALTER TABLE "ConnectionToken" ADD CONSTRAINT "ConnectionToken_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AgentConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
