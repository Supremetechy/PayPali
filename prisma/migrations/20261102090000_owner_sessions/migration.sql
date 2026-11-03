-- Owner sign-in: sessions and single-use email sign-in links (token hashes only).
CREATE TABLE "OwnerSession" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "OwnerSession_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OwnerSession_ownerId_idx" ON "OwnerSession"("ownerId");

CREATE TABLE "LoginLink" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "next" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    CONSTRAINT "LoginLink_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LoginLink_ownerId_idx" ON "LoginLink"("ownerId");
