-- KYC identity issuer: sessions, verified persons (no PII), HMAC fingerprints, revocations.
CREATE TYPE "KycSessionStatus" AS ENUM ('PENDING', 'PROCESSING', 'REQUIRES_INPUT', 'VERIFIED', 'CANCELED', 'DUPLICATE', 'FAILED');

CREATE TABLE "KycSession" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerSessionId" TEXT,
    "status" "KycSessionStatus" NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "personId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KycSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KycSession_providerSessionId_key" ON "KycSession"("providerSessionId");
CREATE INDEX "KycSession_ownerId_createdAt_idx" ON "KycSession"("ownerId", "createdAt");

CREATE TABLE "KycPerson" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KycPerson_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KycPerson_ownerId_key" ON "KycPerson"("ownerId");

CREATE TABLE "KycFingerprint" (
    "hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KycFingerprint_pkey" PRIMARY KEY ("hash")
);
CREATE INDEX "KycFingerprint_personId_idx" ON "KycFingerprint"("personId");
ALTER TABLE "KycFingerprint" ADD CONSTRAINT "KycFingerprint_personId_fkey" FOREIGN KEY ("personId") REFERENCES "KycPerson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "IdentityRevocation" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "doc" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IdentityRevocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IdentityRevocation_issuer_subject_key" ON "IdentityRevocation"("issuer", "subject");
CREATE INDEX "IdentityRevocation_ownerId_idx" ON "IdentityRevocation"("ownerId");
