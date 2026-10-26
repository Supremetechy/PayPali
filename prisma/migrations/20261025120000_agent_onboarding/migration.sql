-- Human onboarding: agent objectives + seeds.

CREATE TYPE "ObjectiveType" AS ENUM ('GROWTH', 'SUSTAIN', 'MAINTAIN');
CREATE TYPE "AgentOrigin" AS ENUM ('HUMAN_ONBOARDED', 'GENERATED');
CREATE TYPE "SeedStatus" AS ENUM ('AUTHORIZED', 'CONSUMED', 'EXPIRED', 'REVOKED');

ALTER TABLE "Agent"
ADD COLUMN "objectiveType" "ObjectiveType",
ADD COLUMN "objectiveMandate" TEXT,
ADD COLUMN "objectiveTargetMinor" BIGINT,
ADD COLUMN "origin" "AgentOrigin" NOT NULL DEFAULT 'HUMAN_ONBOARDED';

CREATE TABLE "Seed" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "fundingSourceReference" TEXT NOT NULL,
    "status" "SeedStatus" NOT NULL DEFAULT 'AUTHORIZED',
    "policyVersion" INTEGER NOT NULL,
    "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Seed_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Seed_ownerId_idx" ON "Seed"("ownerId");
CREATE INDEX "Seed_agentId_status_idx" ON "Seed"("agentId", "status");

ALTER TABLE "Seed"
ADD CONSTRAINT "Seed_ownerId_fkey"
FOREIGN KEY ("ownerId") REFERENCES "Owner"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Seed"
ADD CONSTRAINT "Seed_agentId_fkey"
FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
