-- Skills, licenses and Gas between agents.
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT 'General',
    "kind" TEXT NOT NULL DEFAULT 'SKILL',
    "version" INTEGER NOT NULL DEFAULT 1,
    "inputSchema" JSONB,
    "outputSchema" JSONB,
    "dependencies" JSONB NOT NULL DEFAULT '[]',
    "executor" TEXT NOT NULL,
    "endpointUrl" TEXT,
    "endpointSecret" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "demo" BOOLEAN NOT NULL DEFAULT false,
    "elevatedFromAgentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Skill_slug_key" ON "Skill"("slug");
CREATE INDEX "Skill_agentId_idx" ON "Skill"("agentId");
CREATE INDEX "Skill_ownerId_idx" ON "Skill"("ownerId");

CREATE TABLE "SkillOffer" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "priceGas" INTEGER NOT NULL,
    "calls" INTEGER,
    "periodDays" INTEGER,
    "sublicensable" BOOLEAN NOT NULL DEFAULT false,
    "royaltyBps" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "SkillOffer_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SkillOffer_skillId_idx" ON "SkillOffer"("skillId");
ALTER TABLE "SkillOffer" ADD CONSTRAINT "SkillOffer_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "License" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'NATIVE',
    "sourceRef" TEXT,
    "skillId" TEXT,
    "skillRef" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "offerId" TEXT,
    "licensorAgentId" TEXT,
    "licenseeAgentId" TEXT NOT NULL,
    "licenseeOwnerId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "priceGas" INTEGER NOT NULL DEFAULT 0,
    "callsTotal" INTEGER,
    "callsUsed" INTEGER NOT NULL DEFAULT 0,
    "prepaidGas" INTEGER NOT NULL DEFAULT 0,
    "sublicensable" BOOLEAN NOT NULL DEFAULT false,
    "royaltyBps" INTEGER NOT NULL DEFAULT 0,
    "capMinor" BIGINT,
    "usedMinor" BIGINT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "License_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "License_source_sourceRef_key" ON "License"("source", "sourceRef");
CREATE INDEX "License_licenseeAgentId_status_idx" ON "License"("licenseeAgentId", "status");
CREATE INDEX "License_licensorAgentId_idx" ON "License"("licensorAgentId");
CREATE INDEX "License_skillId_idx" ON "License"("skillId");

CREATE TABLE "SkillCall" (
    "id" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "callerAgentId" TEXT NOT NULL,
    "connectionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "totalGas" INTEGER NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "lines" JSONB NOT NULL,
    "outputHash" TEXT,
    "reason" TEXT,
    "stakeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    CONSTRAINT "SkillCall_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SkillCall_callerAgentId_createdAt_idx" ON "SkillCall"("callerAgentId", "createdAt");
CREATE INDEX "SkillCall_skillId_createdAt_idx" ON "SkillCall"("skillId", "createdAt");

CREATE TABLE "AgentGasAccount" (
    "agentId" TEXT NOT NULL,
    "actFeeGas" INTEGER NOT NULL DEFAULT 0,
    "maxFeeGas" INTEGER NOT NULL DEFAULT 500,
    "carryMilli" INTEGER NOT NULL DEFAULT 0,
    "earnedGas" BIGINT NOT NULL DEFAULT 0,
    "spentGas" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentGasAccount_pkey" PRIMARY KEY ("agentId")
);
