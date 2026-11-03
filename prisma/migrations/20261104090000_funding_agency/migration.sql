-- Funding from PayPal (orders, saved PayPal, allowances, beneficiary sweeps), Power of Agency, kill switch.
CREATE TYPE "FundingPurpose" AS ENUM ('SEED', 'TOPUP', 'ALLOWANCE');
CREATE TYPE "FundingOrderStatus" AS ENUM ('CREATED', 'CAPTURED', 'DECLINED', 'FAILED', 'CANCELLED');
CREATE TYPE "AllowanceStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED');
CREATE TYPE "AgencyStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'REVOKED');

CREATE TABLE "FundingOrder" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "agentId" TEXT,
    "purpose" "FundingPurpose" NOT NULL,
    "provider" TEXT NOT NULL,
    "providerOrderId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "FundingOrderStatus" NOT NULL DEFAULT 'CREATED',
    "saveForAllowance" BOOLEAN NOT NULL DEFAULT false,
    "approveUrl" TEXT,
    "captureId" TEXT,
    "ledgerKey" TEXT,
    "allowanceRunId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FundingOrder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FundingOrder_providerOrderId_key" ON "FundingOrder"("providerOrderId");
CREATE UNIQUE INDEX "FundingOrder_captureId_key" ON "FundingOrder"("captureId");
CREATE INDEX "FundingOrder_agentId_createdAt_idx" ON "FundingOrder"("agentId", "createdAt");
CREATE INDEX "FundingOrder_ownerId_createdAt_idx" ON "FundingOrder"("ownerId", "createdAt");

CREATE TABLE "OwnerPaymentMethod" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "vaultIdSealed" TEXT NOT NULL,
    "customerId" TEXT,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OwnerPaymentMethod_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OwnerPaymentMethod_ownerId_idx" ON "OwnerPaymentMethod"("ownerId");

CREATE TABLE "Allowance" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "paymentMethodId" TEXT,
    "status" "AllowanceStatus" NOT NULL DEFAULT 'ACTIVE',
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Allowance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Allowance_agentId_key" ON "Allowance"("agentId");
CREATE INDEX "Allowance_status_nextRunAt_idx" ON "Allowance"("status", "nextRunAt");

CREATE TABLE "AllowanceRun" (
    "id" TEXT NOT NULL,
    "allowanceId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "fundingOrderId" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AllowanceRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AllowanceRun_allowanceId_periodKey_key" ON "AllowanceRun"("allowanceId", "periodKey");

CREATE TABLE "BeneficiarySweep" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "receiver" TEXT NOT NULL,
    "keepMinor" BIGINT NOT NULL,
    "minPayoutMinor" BIGINT NOT NULL DEFAULT 100,
    "currency" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastResult" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BeneficiarySweep_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BeneficiarySweep_agentId_key" ON "BeneficiarySweep"("agentId");
CREATE INDEX "BeneficiarySweep_status_nextRunAt_idx" ON "BeneficiarySweep"("status", "nextRunAt");

CREATE TABLE "PowerOfAgency" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "AgencyStatus" NOT NULL DEFAULT 'ACTIVE',
    "terms" JSONB NOT NULL,
    "termsSha256" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    CONSTRAINT "PowerOfAgency_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PowerOfAgency_agentId_version_key" ON "PowerOfAgency"("agentId", "version");
CREATE INDEX "PowerOfAgency_agentId_status_idx" ON "PowerOfAgency"("agentId", "status");

CREATE TABLE "AgentStopEvent" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "effects" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentStopEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgentStopEvent_agentId_createdAt_idx" ON "AgentStopEvent"("agentId", "createdAt");
