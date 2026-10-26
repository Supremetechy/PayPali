import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AgentWalletService } from '../src/services/AgentWalletService';
import { AgentSkills } from '../src/skills/AgentSkills';
import { OnboardingService } from '../src/onboarding/OnboardingService';
import { SeedFundingWorker } from '../src/workers/SeedFundingWorker';
import { createTestDb, FakePayPalFundingGateway, TestDb } from './harness';

const CURRENCY = 'USD';

let db: TestDb;
let prisma: PrismaClient;
let wallet: AgentWalletService;

beforeEach(async () => {
  db = await createTestDb();
  prisma = db.prisma;
  wallet = new AgentWalletService(prisma);
});

afterEach(async () => {
  await db.close();
});

async function makeAgent(name = 'agent', active = true): Promise<{ agentId: string; ownerId: string }> {
  const owner = await prisma.owner.create({ data: { email: `o_${randomUUID()}@example.com` } });
  const agent = await prisma.agent.create({
    data: { ownerId: owner.id, name, isActive: active },
  });
  return { agentId: agent.id, ownerId: owner.id };
}

const key = () => `idem_${randomUUID()}`;

describe('AgentWalletService.receive', () => {
  it('credits the balance and records a self-verifying ledger entry', async () => {
    const { agentId } = await makeAgent();
    const res = await wallet.receive({
      agentId,
      amountMinor: 50_000n,
      currency: CURRENCY,
      idempotencyKey: key(),
      type: 'EXTERNAL_TOPUP',
    });

    expect(res.direction).toBe('CREDIT');
    expect(res.balanceAfterMinor).toBe(50_000n);
    expect(res.replayed).toBe(false);
    expect(await wallet.getBalance(agentId, CURRENCY)).toBe(50_000n);

    const entry = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: res.entryId } });
    expect(entry.type).toBe('EXTERNAL_TOPUP');
    expect(entry.balanceAfterMinor).toBe(50_000n);
  });

  it('is idempotent: a replayed key does not double-credit', async () => {
    const { agentId } = await makeAgent();
    const k = key();
    const first = await wallet.receive({ agentId, amountMinor: 1_000n, currency: CURRENCY, idempotencyKey: k });
    const second = await wallet.receive({ agentId, amountMinor: 1_000n, currency: CURRENCY, idempotencyKey: k });

    expect(second.replayed).toBe(true);
    expect(second.entryId).toBe(first.entryId);
    expect(await wallet.getBalance(agentId, CURRENCY)).toBe(1_000n);
  });

  it('rejects a reused key with different details', async () => {
    const { agentId } = await makeAgent();
    const k = key();
    await wallet.receive({ agentId, amountMinor: 1_000n, currency: CURRENCY, idempotencyKey: k });
    await expect(
      wallet.receive({ agentId, amountMinor: 2_000n, currency: CURRENCY, idempotencyKey: k })
    ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
  });

  it('rejects a non-positive amount', async () => {
    const { agentId } = await makeAgent();
    await expect(
      wallet.receive({ agentId, amountMinor: 0n, currency: CURRENCY, idempotencyKey: key() })
    ).rejects.toThrow('INVALID_AMOUNT');
  });
});

describe('AgentWalletService.spend', () => {
  it('debits an available balance', async () => {
    const { agentId } = await makeAgent();
    await wallet.receive({ agentId, amountMinor: 10_000n, currency: CURRENCY, idempotencyKey: key() });

    const res = await wallet.spend({ agentId, amountMinor: 3_500n, currency: CURRENCY, idempotencyKey: key() });
    expect(res.direction).toBe('DEBIT');
    expect(res.balanceAfterMinor).toBe(6_500n);
    expect(await wallet.getBalance(agentId, CURRENCY)).toBe(6_500n);
  });

  it('fails closed on insufficient funds and leaves the balance intact', async () => {
    const { agentId } = await makeAgent();
    await wallet.receive({ agentId, amountMinor: 1_000n, currency: CURRENCY, idempotencyKey: key() });

    await expect(
      wallet.spend({ agentId, amountMinor: 5_000n, currency: CURRENCY, idempotencyKey: key() })
    ).rejects.toThrow('INSUFFICIENT_FUNDS');
    expect(await wallet.getBalance(agentId, CURRENCY)).toBe(1_000n);
  });

  it('refuses to spend from an inactive agent', async () => {
    const { agentId } = await makeAgent('paused', false);
    await expect(
      wallet.spend({ agentId, amountMinor: 1n, currency: CURRENCY, idempotencyKey: key() })
    ).rejects.toThrow('AGENT_INACTIVE');
  });

  it('is idempotent on replay', async () => {
    const { agentId } = await makeAgent();
    await wallet.receive({ agentId, amountMinor: 10_000n, currency: CURRENCY, idempotencyKey: key() });
    const k = key();
    const first = await wallet.spend({ agentId, amountMinor: 2_000n, currency: CURRENCY, idempotencyKey: k });
    const second = await wallet.spend({ agentId, amountMinor: 2_000n, currency: CURRENCY, idempotencyKey: k });
    expect(second.replayed).toBe(true);
    expect(second.entryId).toBe(first.entryId);
    expect(await wallet.getBalance(agentId, CURRENCY)).toBe(8_000n);
  });
});

describe('AgentWalletService.send', () => {
  it('moves funds atomically between two agents with both legs recorded', async () => {
    const a = await makeAgent('sender');
    const b = await makeAgent('recipient');
    await wallet.receive({ agentId: a.agentId, amountMinor: 10_000n, currency: CURRENCY, idempotencyKey: key() });

    const res = await wallet.send({
      fromAgentId: a.agentId,
      toAgentId: b.agentId,
      amountMinor: 4_000n,
      currency: CURRENCY,
      idempotencyKey: key(),
    });

    expect(res.fromBalanceAfterMinor).toBe(6_000n);
    expect(res.toBalanceAfterMinor).toBe(4_000n);
    expect(await wallet.getBalance(a.agentId, CURRENCY)).toBe(6_000n);
    expect(await wallet.getBalance(b.agentId, CURRENCY)).toBe(4_000n);

    const legs = await prisma.ledgerEntry.findMany({ where: { transferId: res.transferId } });
    expect(legs).toHaveLength(2);
    expect(legs.map((l) => l.direction).sort()).toEqual(['CREDIT', 'DEBIT']);
  });

  it('rejects a self-transfer', async () => {
    const a = await makeAgent();
    await expect(
      wallet.send({
        fromAgentId: a.agentId,
        toAgentId: a.agentId,
        amountMinor: 1n,
        currency: CURRENCY,
        idempotencyKey: key(),
      })
    ).rejects.toThrow('SELF_TRANSFER_NOT_ALLOWED');
  });

  it('fails closed on insufficient funds without moving money or recording a transfer', async () => {
    const a = await makeAgent('sender');
    const b = await makeAgent('recipient');
    await wallet.receive({ agentId: a.agentId, amountMinor: 1_000n, currency: CURRENCY, idempotencyKey: key() });

    await expect(
      wallet.send({
        fromAgentId: a.agentId,
        toAgentId: b.agentId,
        amountMinor: 5_000n,
        currency: CURRENCY,
        idempotencyKey: key(),
      })
    ).rejects.toThrow('INSUFFICIENT_FUNDS');

    expect(await wallet.getBalance(a.agentId, CURRENCY)).toBe(1_000n);
    expect(await wallet.getBalance(b.agentId, CURRENCY)).toBe(0n);
    expect(await prisma.agentTransfer.count()).toBe(0);
  });

  it('refuses to send to an inactive recipient and rolls back', async () => {
    const a = await makeAgent('sender');
    const b = await makeAgent('recipient', false);
    await wallet.receive({ agentId: a.agentId, amountMinor: 5_000n, currency: CURRENCY, idempotencyKey: key() });

    await expect(
      wallet.send({
        fromAgentId: a.agentId,
        toAgentId: b.agentId,
        amountMinor: 1_000n,
        currency: CURRENCY,
        idempotencyKey: key(),
      })
    ).rejects.toThrow('AGENT_INACTIVE');
    expect(await wallet.getBalance(a.agentId, CURRENCY)).toBe(5_000n);
    expect(await prisma.agentTransfer.count()).toBe(0);
  });

  it('is idempotent: a replayed transfer key moves money once', async () => {
    const a = await makeAgent('sender');
    const b = await makeAgent('recipient');
    await wallet.receive({ agentId: a.agentId, amountMinor: 10_000n, currency: CURRENCY, idempotencyKey: key() });
    const k = key();

    const first = await wallet.send({
      fromAgentId: a.agentId, toAgentId: b.agentId, amountMinor: 3_000n, currency: CURRENCY, idempotencyKey: k,
    });
    const second = await wallet.send({
      fromAgentId: a.agentId, toAgentId: b.agentId, amountMinor: 3_000n, currency: CURRENCY, idempotencyKey: k,
    });

    expect(second.replayed).toBe(true);
    expect(second.transferId).toBe(first.transferId);
    expect(await wallet.getBalance(a.agentId, CURRENCY)).toBe(7_000n);
    expect(await wallet.getBalance(b.agentId, CURRENCY)).toBe(3_000n);
    expect(await prisma.agentTransfer.count()).toBe(1);
  });
});

describe('AgentSkills facade + onboarding integration', () => {
  it('lets an onboarded agent receive, spend, and send end-to-end', async () => {
    const onboarding = new OnboardingService(prisma);
    const fundingWorker = new SeedFundingWorker(prisma, new FakePayPalFundingGateway(), {
      pollIntervalMs: 50,
      leaseDurationMs: 1_000,
      retryBaseMs: 10,
    });

    // Onboarding queues seed funding; the worker captures it from PayPal.
    const buyer = await onboarding.generateAgent({
      owner: { email: `o_${randomUUID()}@example.com` },
      objective: { type: 'GROWTH' },
      seed: { amountMinor: 1_000_000n, currency: CURRENCY, fundingSourceReference: 'vault_a' },
    });
    const supplier = await makeAgent('supplier');
    expect(buyer.fundingStatus).toBe('PENDING');

    await fundingWorker.processNext();

    const buyerSkills = new AgentSkills(wallet, { agentId: buyer.agentId, ownerId: buyer.ownerId });

    // Funded once the capture settled — no separate top-up needed.
    expect(await buyerSkills.getBalance(CURRENCY)).toBe(1_000_000n);

    // receive: an additional inbound credit (e.g. a refund) stacks on the seed.
    await buyerSkills.receive({
      amountMinor: 50_000n,
      currency: CURRENCY,
      idempotencyKey: key(),
      type: 'REFUND',
    });
    expect(await buyerSkills.getBalance(CURRENCY)).toBe(1_050_000n);

    // spend: commit to an external payment.
    await buyerSkills.spend({ amountMinor: 250_000n, currency: CURRENCY, idempotencyKey: key() });
    expect(await buyerSkills.getBalance(CURRENCY)).toBe(800_000n);

    // send: pay another agent.
    const sent = await buyerSkills.send({
      toAgentId: supplier.agentId,
      amountMinor: 300_000n,
      currency: CURRENCY,
      idempotencyKey: key(),
    });
    expect(sent.fromBalanceAfterMinor).toBe(500_000n);
    expect(await wallet.getBalance(supplier.agentId, CURRENCY)).toBe(300_000n);
  });
});
