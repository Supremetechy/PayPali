-- Merchant Connect refunds (AgentBazaar non-delivery).
ALTER TYPE "MerchantChargeStatus" ADD VALUE 'REFUNDED';
ALTER TABLE "MerchantCharge" ADD COLUMN "refundedAt" TIMESTAMP(3);
ALTER TABLE "MerchantCharge" ADD COLUMN "refundTransferId" TEXT;
