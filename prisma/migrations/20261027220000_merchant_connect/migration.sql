-- Merchant Connect: owner-issued merchant grants, Score-gated merchant charges,
-- merchant payouts, and the outbound merchant webhook outbox.

CREATE TYPE "MerchantGrantStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "MerchantChargeStatus" AS ENUM ('PENDING', 'PAID', 'DECLINED');
CREATE TYPE "MerchantEventStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

CREATE TABLE "MerchantGrant" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "maxMinor" BIGINT NOT NULL,
    "usedMinor" BIGINT NOT NULL DEFAULT 0,
    "status" "MerchantGrantStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantGrant_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MerchantGrant_agentId_idx" ON "MerchantGrant"("agentId");
CREATE INDEX "MerchantGrant_merchantId_idx" ON "MerchantGrant"("merchantId");

CREATE TABLE "MerchantCharge" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "reference" TEXT NOT NULL DEFAULT '',
    "intentKey" TEXT NOT NULL,
    "status" "MerchantChargeStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "transferId" TEXT,
    "stakeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantCharge_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MerchantCharge_merchantId_idempotencyKey_key" ON "MerchantCharge"("merchantId", "idempotencyKey");
CREATE INDEX "MerchantCharge_agentId_idx" ON "MerchantCharge"("agentId");

CREATE TABLE "MerchantPayout" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "toAgentId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "reference" TEXT NOT NULL DEFAULT '',
    "transferId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantPayout_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MerchantPayout_merchantId_idempotencyKey_key" ON "MerchantPayout"("merchantId", "idempotencyKey");

CREATE TABLE "MerchantEvent" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "MerchantEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MerchantEvent_status_availableAt_idx" ON "MerchantEvent"("status", "availableAt");

ALTER TABLE "MerchantCharge" ADD CONSTRAINT "MerchantCharge_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "MerchantGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
