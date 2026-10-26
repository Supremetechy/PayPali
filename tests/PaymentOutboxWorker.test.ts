import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntentStatus, OutboxEventStatus, OutboxEventType, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PaymentOutboxWorker } from '../src/workers/PaymentOutboxWorker';
import { LedgerService } from '../src/services/LedgerService';
import { AgentWalletService } from '../src/services/AgentWalletService';
import {
  createTestDb,
  FakeBraintreeProvider,
  TestDb,
  seedOwnerAgentPolicy,
  simulateStaleSubmitting,
  makeClaimable,
  success,
  declined,
  SEEDED_WALLET_MINOR,
} from './harness';

const RECIPIENT = 'rec_trusted_1';
const MCC = '5812';
const CURRENCY = 'USD';
const AMOUNT = 5_000n;
const LEASE_MS = 1_000;

let db: TestDb;
let prisma: PrismaClient;

beforeEach(async () => {
  db = await createTestDb();
  prisma = db.prisma;
});

afterEach(async () => {
  await db.close();
});

async function reserveIntent(): Promise<{ intentId: string; agentId: string }> {
  const { agentId, ownerId } = await seedOwnerAgentPolicy(prisma, {
    currency: CURRENCY,
    recipientId: RECIPIENT,
    merchantCategoryCode: MCC,
    requireHumanApprovalAbove: 1_000_000n, // well above AMOUNT -> no approval needed
  });
  const ledger = new LedgerService(prisma);
  const res = await ledger.reserveAndQueuePayment({
    idempotencyKey: `idem_${randomUUID()}`,
    agentId,
    ownerId,
    recipientId: RECIPIENT,
    merchantCategoryCode: MCC,
    amountMinor: AMOUNT,
    currency: CURRENCY,
    paymentMethodRef: 'vault_ref_abc',
  });
  expect(res.status).toBe(IntentStatus.RESERVED);
  return { intentId: res.intentId, agentId };
}

function makeWorker(
  provider: FakeBraintreeProvider,
  resolvePaymentMethod: (ref: string) => Promise<string> = async () => 'pm_vault_token'
): PaymentOutboxWorker {
  return new PaymentOutboxWorker(prisma, provider, resolvePaymentMethod, {
    leaseDurationMs: LEASE_MS,
    reconciliationDelayMs: 5_000,
    pollIntervalMs: 50,
  });
}

async function auditActions(intentId: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    where: { traceId: intentId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => r.action);
}

describe('PaymentOutboxWorker — happy path', () => {
  it('settles a reserved payment, commits the reservation, and debits the wallet', async () => {
    const { intentId, agentId } = await reserveIntent();
    const wallet = new AgentWalletService(prisma);

    // Reservation held the funds: available down, reserved up.
    expect(await wallet.getBalance(agentId, CURRENCY)).toBe(SEEDED_WALLET_MINOR - AMOUNT);
    expect(await wallet.getReserved(agentId, CURRENCY)).toBe(AMOUNT);

    const provider = new FakeBraintreeProvider().queueCharge(success(AMOUNT, CURRENCY, 'txn_777'));

    const didWork = await makeWorker(provider).processNext();

    expect(didWork).toBe(true);
    expect(provider.chargeCalls).toHaveLength(1);

    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe(IntentStatus.SETTLED);
    expect(intent.providerTransactionId).toBe('txn_777');

    const reservation = await prisma.spendReservation.findUniqueOrThrow({ where: { intentId } });
    expect(reservation.status).toBe('COMMITTED');

    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { intentId } });
    expect(event.status).toBe(OutboxEventStatus.COMPLETED);

    expect(await auditActions(intentId)).toContain('PAYMENT_SETTLED');

    // Settlement committed the hold: funds left the wallet, nothing still held.
    expect(await wallet.getBalance(agentId, CURRENCY)).toBe(SEEDED_WALLET_MINOR - AMOUNT);
    expect(await wallet.getReserved(agentId, CURRENCY)).toBe(0n);
    const spend = await prisma.ledgerEntry.findUniqueOrThrow({
      where: { idempotencyKey: `commit:${intentId}` },
    });
    expect(spend.type).toBe('SPEND');
  });
});

describe('PaymentOutboxWorker — definitive decline', () => {
  it('fails the intent, releases the reservation, and returns the held funds', async () => {
    const { intentId, agentId } = await reserveIntent();
    const provider = new FakeBraintreeProvider().queueCharge(declined('DO_NOT_HONOR'));

    await makeWorker(provider).processNext();

    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe(IntentStatus.FAILED);
    expect(intent.failureReason).toBe('DO_NOT_HONOR');

    const reservation = await prisma.spendReservation.findUniqueOrThrow({ where: { intentId } });
    expect(reservation.status).toBe('RELEASED');

    // Decline released the hold: full balance back, nothing held, no SPEND.
    const wallet = new AgentWalletService(prisma);
    expect(await wallet.getBalance(agentId, CURRENCY)).toBe(SEEDED_WALLET_MINOR);
    expect(await wallet.getReserved(agentId, CURRENCY)).toBe(0n);
  });
});

describe('PaymentOutboxWorker — ambiguous charge then reconcile', () => {
  it('moves to AMBIGUOUS on a thrown charge, then settles via reconcile', async () => {
    const { intentId } = await reserveIntent();
    const provider = new FakeBraintreeProvider()
      .queueCharge(new Error('ETIMEDOUT'))
      .queueReconcile(success(AMOUNT, CURRENCY, 'txn_recon'));

    // First pass: charge throws -> schedule reconciliation.
    await makeWorker(provider).processNext();

    let intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe(IntentStatus.AMBIGUOUS_PENDING_RECONCILIATION);
    let event = await prisma.outboxEvent.findUniqueOrThrow({ where: { intentId } });
    expect(event.type).toBe(OutboxEventType.RECONCILE);
    expect(event.status).toBe(OutboxEventStatus.PENDING);
    expect(provider.chargeCalls).toHaveLength(1);
    expect(provider.reconcileCalls).toHaveLength(0);

    // Second pass: reconcile reports success -> settle.
    await makeClaimable(prisma, intentId);
    await makeWorker(provider).processNext();

    intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe(IntentStatus.SETTLED);
    expect(intent.providerTransactionId).toBe('txn_recon');
    expect(provider.reconcileCalls).toEqual([intentId]);
    expect(provider.chargeCalls).toHaveLength(1); // never re-charged
  });
});

describe('PaymentOutboxWorker — reclaimed SUBMITTING reconciles first (edge case)', () => {
  it('never re-dispatches a reclaimed SUBMITTING event; routes it to reconcile', async () => {
    const { intentId } = await reserveIntent();
    await simulateStaleSubmitting(prisma, intentId, LEASE_MS);

    // Empty charge queue: any dispatch attempt would throw and fail the test.
    const provider = new FakeBraintreeProvider();
    const didWork = await makeWorker(provider).processNext();

    expect(didWork).toBe(true);
    expect(provider.chargeCalls).toHaveLength(0);

    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe(IntentStatus.AMBIGUOUS_PENDING_RECONCILIATION);

    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { intentId } });
    expect(event.type).toBe(OutboxEventType.RECONCILE);
    expect(event.status).toBe(OutboxEventStatus.PENDING);
    expect(event.lockToken).toBeNull();

    expect(await auditActions(intentId)).toContain('PAYMENT_REQUIRES_RECONCILIATION');
  });
});

describe('PaymentOutboxWorker — pre-dispatch recheck', () => {
  it('cancels a payment whose agent went inactive between SUBMITTING and dispatch', async () => {
    const { intentId, agentId } = await reserveIntent();

    // Resolver runs AFTER markSubmitting and BEFORE revalidateBeforeDispatch;
    // flip the agent inactive there so only the pre-dispatch recheck can catch it.
    let flipped = false;
    const resolver = async () => {
      if (!flipped) {
        flipped = true;
        await prisma.agent.update({ where: { id: agentId }, data: { isActive: false } });
      }
      return 'pm_vault_token';
    };

    const provider = new FakeBraintreeProvider(); // no charge queued
    await makeWorker(provider, resolver).processNext();

    expect(provider.chargeCalls).toHaveLength(0);

    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe(IntentStatus.CANCELLED);
    expect(intent.failureReason).toBe('AGENT_INACTIVE_OR_UNAUTHORIZED');

    const reservation = await prisma.spendReservation.findUniqueOrThrow({ where: { intentId } });
    expect(reservation.status).toBe('RELEASED');

    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { intentId } });
    expect(event.status).toBe(OutboxEventStatus.COMPLETED);

    expect(await auditActions(intentId)).toContain('PAYMENT_CANCELLED_BEFORE_SUBMISSION');
  });

  it('cancels at markSubmitting when the agent is already inactive', async () => {
    const { intentId, agentId } = await reserveIntent();
    await prisma.agent.update({ where: { id: agentId }, data: { isActive: false } });

    const provider = new FakeBraintreeProvider(); // no charge queued
    await makeWorker(provider).processNext();

    expect(provider.chargeCalls).toHaveLength(0);
    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe(IntentStatus.CANCELLED);
    expect(intent.failureReason).toBe('AGENT_INACTIVE_OR_UNAUTHORIZED');
  });
});

describe('PaymentOutboxWorker — settlement integrity guard', () => {
  it('reconciles instead of settling when the provider amount disagrees', async () => {
    const { intentId } = await reserveIntent();
    const provider = new FakeBraintreeProvider().queueCharge(success(AMOUNT + 1n, CURRENCY));

    await makeWorker(provider).processNext();

    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe(IntentStatus.AMBIGUOUS_PENDING_RECONCILIATION);
    expect(intent.providerTransactionId).toBeNull();
  });
});
