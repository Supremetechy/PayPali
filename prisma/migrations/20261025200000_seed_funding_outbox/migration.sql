-- Crash-safe seed funding: funding outbox + a terminal FUNDING_FAILED state.

ALTER TYPE "SeedStatus" ADD VALUE IF NOT EXISTS 'FUNDING_FAILED';

CREATE TYPE "SeedFundingStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE "SeedFundingOutbox" (
    "id" TEXT NOT NULL,
    "seedId" TEXT NOT NULL,
    "status" "SeedFundingStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockToken" TEXT,
    "lastError" TEXT,
    "captureIdempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeedFundingOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SeedFundingOutbox_seedId_key" ON "SeedFundingOutbox"("seedId");
CREATE UNIQUE INDEX "SeedFundingOutbox_captureIdempotencyKey_key"
ON "SeedFundingOutbox"("captureIdempotencyKey");
CREATE INDEX "SeedFundingOutbox_status_availableAt_idx"
ON "SeedFundingOutbox"("status", "availableAt");
CREATE INDEX "SeedFundingOutbox_status_lockedAt_idx"
ON "SeedFundingOutbox"("status", "lockedAt");

ALTER TABLE "SeedFundingOutbox"
ADD CONSTRAINT "SeedFundingOutbox_seedId_fkey"
FOREIGN KEY ("seedId") REFERENCES "Seed"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
