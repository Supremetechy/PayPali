-- Agent Development: knowledge modules, skills, capability grants, behavioral
-- memory, and the stake-before-act score ledger.

-- Score Pool credit leg for forfeited score bonds.
ALTER TYPE "LedgerEntryType" ADD VALUE 'SCORE_FORFEIT';

CREATE TYPE "RiskClass" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "FactStatus" AS ENUM ('ACTIVE', 'PROPOSED', 'SUPERSEDED', 'RETIRED');
CREATE TYPE "ScoreStatus" AS ENUM ('ACTIVE', 'PROBATION', 'SUSPENDED');
CREATE TYPE "StakeStatus" AS ENUM ('OPEN', 'WON', 'LOST', 'EXPIRED');
CREATE TYPE "MemoryKind" AS ENUM ('LESSON', 'BEHAVIOR', 'PREFERENCE');

CREATE TABLE "KnowledgeModule" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeModule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KnowledgeModule_ownerId_name_key" ON "KnowledgeModule"("ownerId", "name");

CREATE TABLE "KnowledgeFact" (
    "id" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "tags" TEXT[],
    "status" "FactStatus" NOT NULL DEFAULT 'ACTIVE',
    "supersededById" TEXT,
    "proposedByAgentId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeFact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "KnowledgeFact_moduleId_status_idx" ON "KnowledgeFact"("moduleId", "status");

CREATE TABLE "AgentModuleBinding" (
    "agentId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentModuleBinding_pkey" PRIMARY KEY ("agentId","moduleId")
);

CREATE TABLE "SkillDefinition" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT NOT NULL DEFAULT '',
    "steps" JSONB NOT NULL,
    "requiredCapabilities" TEXT[],
    "riskClass" "RiskClass" NOT NULL DEFAULT 'LOW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillDefinition_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SkillDefinition_ownerId_name_version_key" ON "SkillDefinition"("ownerId", "name", "version");

CREATE TABLE "AgentSkillBinding" (
    "agentId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentSkillBinding_pkey" PRIMARY KEY ("agentId","skillId")
);

CREATE TABLE "CapabilityGrant" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "maxRisk" "RiskClass" NOT NULL DEFAULT 'LOW',
    "grantedBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CapabilityGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CapabilityGrant_agentId_capability_key" ON "CapabilityGrant"("agentId", "capability");

CREATE TABLE "AgentMemory" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "MemoryKind" NOT NULL,
    "content" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentMemory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentMemory_agentId_key_key" ON "AgentMemory"("agentId", "key");

CREATE TABLE "AgentScore" (
    "agentId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL,
    "lockedPoints" INTEGER NOT NULL DEFAULT 0,
    "floor" INTEGER NOT NULL,
    "status" "ScoreStatus" NOT NULL DEFAULT 'ACTIVE',
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentScore_pkey" PRIMARY KEY ("agentId")
);

CREATE TABLE "ScoreStake" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "intentKey" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "capability" TEXT NOT NULL,
    "skillId" TEXT,
    "riskClass" "RiskClass" NOT NULL,
    "confidencePct" INTEGER NOT NULL,
    "stake" INTEGER NOT NULL,
    "fee" INTEGER NOT NULL,
    "lockedPoints" INTEGER NOT NULL,
    "status" "StakeStatus" NOT NULL DEFAULT 'OPEN',
    "delta" INTEGER,
    "evidence" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoreStake_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ScoreStake_agentId_intentKey_attemptNo_key" ON "ScoreStake"("agentId", "intentKey", "attemptNo");
CREATE INDEX "ScoreStake_agentId_status_idx" ON "ScoreStake"("agentId", "status");
CREATE INDEX "ScoreStake_status_expiresAt_idx" ON "ScoreStake"("status", "expiresAt");

ALTER TABLE "KnowledgeFact" ADD CONSTRAINT "KnowledgeFact_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "KnowledgeModule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentModuleBinding" ADD CONSTRAINT "AgentModuleBinding_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "KnowledgeModule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentSkillBinding" ADD CONSTRAINT "AgentSkillBinding_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "SkillDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
