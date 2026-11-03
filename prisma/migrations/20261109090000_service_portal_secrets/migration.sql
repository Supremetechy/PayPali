CREATE TABLE "ServicePortalSecret" (
    "serviceId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServicePortalSecret_pkey" PRIMARY KEY ("serviceId")
);
