-- Gas floats with demand: each call and prepaid license records the price it was made at.
ALTER TABLE "SkillCall" ADD COLUMN "gasPriceMilli" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "License" ADD COLUMN "gasPriceMilli" INTEGER NOT NULL DEFAULT 100;

CREATE TABLE "GasPriceEpoch" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "priceMilli" INTEGER NOT NULL,
    "demandGas" BIGINT NOT NULL,
    "targetGas" BIGINT NOT NULL,
    "nextPriceMilli" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GasPriceEpoch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "GasPriceEpoch_endedAt_idx" ON "GasPriceEpoch"("endedAt");
