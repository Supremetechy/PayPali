-- Seed auto-activation: record the PayPal capture that funded the seed.

ALTER TABLE "Seed"
ADD COLUMN "fundingCaptureId" TEXT;
