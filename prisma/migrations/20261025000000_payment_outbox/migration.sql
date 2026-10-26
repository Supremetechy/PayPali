CREATE TYPE "OutboxEventType" AS ENUM ('SUBMIT', 'RECONCILE');
CREATE TYPE "OutboxEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED');

ALTER TABLE "PaymentIntent"
ADD COLUMN "paymentMethodRef" TEXT;

CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "type" "OutboxEventType" NOT NULL,
    "status" "OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockToken" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OutboxEvent_intentId_key" ON "OutboxEvent"("intentId");
CREATE INDEX "OutboxEvent_status_availableAt_idx"
ON "OutboxEvent"("status", "availableAt");
CREATE INDEX "OutboxEvent_status_lockedAt_idx"
ON "OutboxEvent"("status", "lockedAt");

ALTER TABLE "OutboxEvent"
ADD CONSTRAINT "OutboxEvent_intentId_fkey"
FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
