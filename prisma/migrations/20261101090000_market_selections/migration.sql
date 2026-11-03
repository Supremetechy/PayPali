-- Marketplace selections per agent.
CREATE TABLE "MarketSelection" (
    "agentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketSelection_pkey" PRIMARY KEY ("agentId", "kind", "itemId")
);
CREATE INDEX "MarketSelection_agentId_idx" ON "MarketSelection"("agentId");
