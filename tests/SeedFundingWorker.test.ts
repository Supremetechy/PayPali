import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { OnboardingService } from '../src/onboarding/OnboardingService';
import { SeedFundingWorker } from '../src/workers/SeedFundingWorker';
import { AgentWalletService } from '../src/services/AgentWalletService';
import {
  createTestDb,
  FakePayPalFundingGateway,
  TestDb,
  simulateStaleSeedFunding,
} from './harness';

const CURRENCY = 'USD';
const SEED = 500_000n;
const LEASE_MS = 1_000;

let db: TestDb;
let prisma: PrismaClient;
let onboarding: OnboardingService;
let funding: FakePayPalFundingGateway;
let worker: SeedFundingWorker;
let wallet: AgentWalletService;

beforeEach(async () => {
  db = await createTestDb();
  prisma = db.prisma;
  onboarding = new OnboardingService(prisma);
  funding = new FakePayPalFundingGateway();
  worker = new SeedFundingWorker(prisma, funding, {
    pollIntervalMs: 50,
    leaseDurationMs: LEASE_MS,
    retryBaseMs: 10,
  });
  wallet = new AgentWalletService(prisma);
});

afterEach(async () => {
  await db.close();
});

async function onboardSeed(): Promise<{ agentId: string; seedId: string }> {
  const result = await onboarding.generateAgent({
    owner: { email: `o_${randomUUID()}@example.com` },
    objective: { type: 'SUSTAIN' },
    seed: { amountMinor: SEED, currency: CURRENCY, fundingSourceReference: 'paypal_bal_1' },
  });
  return { agentId: result.agentId, seedId: result.seedId };
}

describe('SeedFundingWorker', () => {
  it('captures the seed from PayPal and credits the wallet exactly once', async () => {
    const { agentId, seedId } = await onboardSeed();

    expect(await worker.processNext()).toBe(true);

    const seed = await prisma.seed.findUniqueOrThrow({ where: { id: seedId } });
    expect(seed.status).toBe('CONSUMED');
    expect(seed.fundingCaptureId).toBeTruthy();

    const outbox = await prisma.seedFundingOutbox.findUniqueOrThrow({ where: { seedId } });
    expect(outbox.status).toBe('COMPLETED');

    expect(await wallet.getBalance(agentId, CURRENCY)).toBe(SEED);

    // Capture used the seed's stable idempotency key.
    expect(funding.captureCalls).toHaveLength(1);
    expect(funding.captureCalls[0].idempotencyKey).toBe(`seed-fund:${seedId}`);

    const entries = await prisma.ledgerEntry.findMany({
      where: { agentId, type: 'SEED_FUNDING' },
    });
    expect(entries).toHaveLength(1);
  });

  it('marks the seed FUNDING_FAILED when PayPal reports insufficient funds', async () => {
    const { agentId, seedId } = await onboardSeed();
    funding.queueResult({ status: 'INSUFFICIENT_FUNDS' });

    await worker.processNext();

    const seed = await prisma.seed.findUniqueOrThrow({ where: { id: seedId } });
    expect(seed.status).toBe('FUNDING_FAILED');
    const outbox = await prisma.seedFundingOutbox.findUniqueOrThrow({ where: { seedId } });
    expect(outbox.status).toBe('FAILED');
    expect(await wallet.getBalance(agentId, CURRENCY)).toBe(0n);
  });

  it('recovers a worker that died mid-capture: reclaims the stale lease and funds once', async () => {
    const { agentId, seedId } = await onboardSeed();
    // Simulate a crash: lease held by a dead token, seed still AUTHORIZED.
    await simulateStaleSeedFunding(prisma, seedId, LEASE_MS);

    expect(await worker.processNext()).toBe(true);

    const seed = await prisma.seed.findUniqueOrThrow({ where: { id: seedId } });
    expect(seed.status).toBe('CONSUMED');
    expect(await wallet.getBalance(agentId, CURRENCY)).toBe(SEED);
    const entries = await prisma.ledgerEntry.findMany({
      where: { agentId, type: 'SEED_FUNDING' },
    });
    expect(entries).toHaveLength(1);
  });

  it('never double-credits if the job is somehow replayed after completion', async () => {
    const { agentId, seedId } = await onboardSeed();
    await worker.processNext(); // funds the seed
    expect(await wallet.getBalance(agentId, CURRENCY)).toBe(SEED);

    // Force the completed job to look claimable again (e.g. a redelivery).
    await prisma.seedFundingOutbox.update({
      where: { seedId },
      data: { status: 'PENDING', availableAt: new Date(Date.now() - 1000), lockedAt: null, lockToken: null },
    });

    await worker.processNext(); // seed already CONSUMED -> closed out as obsolete

    expect(await wallet.getBalance(agentId, CURRENCY)).toBe(SEED);
    const entries = await prisma.ledgerEntry.findMany({
      where: { agentId, type: 'SEED_FUNDING' },
    });
    expect(entries).toHaveLength(1);
    const outbox = await prisma.seedFundingOutbox.findUniqueOrThrow({ where: { seedId } });
    expect(outbox.status).toBe('COMPLETED');
  });
});
