-- Solutions Farm storefront linked to PayPali accounts (Connect PayPali on Buy and Sell).
ALTER TABLE "MerchantGrant" ADD COLUMN "principalPub" TEXT;

CREATE TABLE "BazaarStorefrontLink" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "pub" TEXT NOT NULL,
    "vendorId" TEXT,
    "grantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "BazaarStorefrontLink_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BazaarStorefrontLink_ownerId_createdAt_idx" ON "BazaarStorefrontLink"("ownerId", "createdAt");
CREATE INDEX "BazaarStorefrontLink_agentId_idx" ON "BazaarStorefrontLink"("agentId");
