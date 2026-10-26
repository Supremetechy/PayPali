-- Connect wallet to merchant settlement: a reserved/held bucket + hold legs.

ALTER TABLE "AgentAccount"
ADD COLUMN "reservedMinor" BIGINT NOT NULL DEFAULT 0;

-- New ledger entry types for the hold lifecycle. ADD VALUE cannot run inside a
-- transaction block, so these are applied as standalone statements.
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'HOLD';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'RELEASE';
