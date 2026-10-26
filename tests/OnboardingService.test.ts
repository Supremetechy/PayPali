import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntentStatus, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { OnboardingService } from '../src/onboarding/OnboardingService';
import { LedgerService } from '../src/services/LedgerService';
import { AgentWalletService } from '../src/services/AgentWalletService';
import { SeedFundingWorker } from '../src/workers/SeedFundingWorker';
import { deriveLimitsFromSeed } from '../src/onboarding/objectiveProfiles';
import { createTestDb, FakePayPalFundingGateway, TestDb } from './harness';

const CURRENCY = 'USD';
const RECIPIENT = 'rec_trusted_1';
const MCC = '5812';
const SEED_MINOR = 1_000_000n; // $10,000.00

let db: TestDb;
let prisma: PrismaClient;
let funding: FakePayPalFundingGateway;
let fundingWorker: SeedFundingWorker;
let onboarding: OnboardingService;

beforeEach(async () => {
  db = await createTestDb();
  prisma = db.prisma;
  funding = new FakePayPalFundingGateway();
  fundingWorker = new SeedFundingWorker(prisma, funding, {
    pollIntervalMs: 50,
    leaseDurationMs: 1_000,
    retryBaseMs: 10,
  });
  onboarding = new OnboardingService(prisma);
});

afterEach(async () => {
  await db.close();
});

function ownerEmail(): string {
  return `owner_${randomUUID()}@example.com`;
}

describe('OnboardingService.onboardAgent', () => {
  it('creates owner, agent, active policy, and seed atomically with an audit trail', async () => {
    const email = ownerEmail();
    const result = await onboarding.onboardAgent({
      owner: { email },
      agentName: 'treasury-bot',
      objective: {
        type: 'SUSTAIN',
        mandate: 'Keep the storefront inventory funded at cost.',
        targetMinor: 500_000n,
      },
      seed: {
        amountMinor: SEED_MINOR,
        currency: CURRENCY,
        fundingSourceReference: 'vault_src_abc',
      },
      policy: {
        maxPerTransactionMinor: 100_000n,
        maxDailyBudgetMinor: 300_000n,
        maxMonthlyBudgetMinor: 1_000_000n,
        requireHumanApprovalAboveMinor: 50_000n,
        allowedRecipients: [RECIPIENT],
        allowedCategories: [MCC],
      },
    });

    expect(result.origin).toBe('HUMAN_ONBOARDED');
    expect(result.objectiveType).toBe('SUSTAIN');
    expect(result.policyVersion).toBe(1);

    const owner = await prisma.owner.findUniqueOrThrow({ where: { email } });
    expect(result.ownerId).toBe(owner.id);

    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: result.agentId } });
    expect(agent.isActive).toBe(true);
    expect(agent.name).toBe('treasury-bot');
    expect(agent.objectiveType).toBe('SUSTAIN');
    expect(agent.objectiveMandate).toBe('Keep the storefront inventory funded at cost.');
    expect(agent.objectiveTargetMinor).toBe(500_000n);

    const policy = await prisma.policy.findUniqueOrThrow({
      where: { ownerId_version: { ownerId: owner.id, version: 1 } },
    });
    expect(policy.isActive).toBe(true);
    expect(policy.allowedRecipients).toEqual([RECIPIENT]);

    // Funding is queued, not yet captured: seed AUTHORIZED, outbox PENDING, wallet at zero.
    expect(result.fundingStatus).toBe('PENDING');
    const wallet = new AgentWalletService(prisma);
    const seedBefore = await prisma.seed.findUniqueOrThrow({ where: { id: result.seedId } });
    expect(seedBefore.status).toBe('AUTHORIZED');
    expect(seedBefore.fundingCaptureId).toBeNull();
    const outbox = await prisma.seedFundingOutbox.findUniqueOrThrow({ where: { seedId: result.seedId } });
    expect(outbox.status).toBe('PENDING');
    expect(await wallet.getBalance(result.agentId, CURRENCY)).toBe(0n);

    const audit = await prisma.auditLog.findFirst({
      where: { traceId: result.agentId, action: 'AGENT_ONBOARDED' },
    });
    expect(audit?.actorType).toBe('OWNER');
    expect(audit?.actorId).toBe(owner.id);

    // The worker captures from the owner's PayPal balance and funds the wallet.
    expect(await fundingWorker.processNext()).toBe(true);

    const seedAfter = await prisma.seed.findUniqueOrThrow({ where: { id: result.seedId } });
    expect(seedAfter.status).toBe('CONSUMED');
    expect(seedAfter.fundingCaptureId).toBeTruthy();
    expect(funding.captureCalls).toHaveLength(1);
    expect(funding.captureCalls[0].amountMinor).toBe(SEED_MINOR);
    expect(await wallet.getBalance(result.agentId, CURRENCY)).toBe(SEED_MINOR);
    const settledOutbox = await prisma.seedFundingOutbox.findUniqueOrThrow({ where: { seedId: result.seedId } });
    expect(settledOutbox.status).toBe('COMPLETED');
  });

  it('produces an agent the ledger immediately authorizes within policy', async () => {
    const result = await onboarding.onboardAgent({
      owner: { email: ownerEmail() },
      agentName: 'buyer',
      objective: { type: 'SUSTAIN', mandate: 'Buy approved supplies.' },
      seed: {
        amountMinor: SEED_MINOR,
        currency: CURRENCY,
        fundingSourceReference: 'vault_src_def',
      },
      policy: {
        maxPerTransactionMinor: 100_000n,
        maxDailyBudgetMinor: 300_000n,
        maxMonthlyBudgetMinor: 1_000_000n,
        requireHumanApprovalAboveMinor: 100_000n, // at the per-tx cap => no approval needed
        allowedRecipients: [RECIPIENT],
        allowedCategories: [MCC],
      },
    });

    // Complete seed funding so the wallet can back the merchant hold.
    await fundingWorker.processNext();

    const ledger = new LedgerService(prisma);
    const payment = await ledger.reserveAndQueuePayment({
      idempotencyKey: `idem_${randomUUID()}`,
      agentId: result.agentId,
      ownerId: result.ownerId,
      recipientId: RECIPIENT,
      merchantCategoryCode: MCC,
      amountMinor: 20_000n,
      currency: CURRENCY,
      paymentMethodRef: 'vault_pm_1',
    });

    expect(payment.status).toBe(IntentStatus.RESERVED);
    expect(payment.policyVersionApplied).toBe(result.policyVersion);
  });

  it('rejects an empty mandate on the full-control path', async () => {
    await expect(
      onboarding.onboardAgent({
        owner: { email: ownerEmail() },
        agentName: 'x',
        objective: { type: 'GROWTH', mandate: '   ' },
        seed: {
          amountMinor: SEED_MINOR,
          currency: CURRENCY,
          fundingSourceReference: 'vault_src',
        },
        policy: {
          maxPerTransactionMinor: 100_000n,
          maxDailyBudgetMinor: 300_000n,
          maxMonthlyBudgetMinor: 1_000_000n,
          requireHumanApprovalAboveMinor: 0n,
          allowedRecipients: [RECIPIENT],
          allowedCategories: [MCC],
        },
      })
    ).rejects.toThrow('INVALID_OBJECTIVE_MANDATE');
  });

  it('rejects internally inconsistent limits (per-tx > daily) and writes nothing', async () => {
    const email = ownerEmail();
    await expect(
      onboarding.onboardAgent({
        owner: { email },
        agentName: 'x',
        objective: { type: 'GROWTH', mandate: 'go' },
        seed: {
          amountMinor: SEED_MINOR,
          currency: CURRENCY,
          fundingSourceReference: 'vault_src',
        },
        policy: {
          maxPerTransactionMinor: 500_000n,
          maxDailyBudgetMinor: 300_000n, // < per-tx
          maxMonthlyBudgetMinor: 1_000_000n,
          requireHumanApprovalAboveMinor: 0n,
          allowedRecipients: [RECIPIENT],
          allowedCategories: [MCC],
        },
      })
    ).rejects.toThrow('INCONSISTENT_POLICY_LIMITS');

    // Validation runs before any persistence, so no owner was created.
    expect(await prisma.owner.findUnique({ where: { email } })).toBeNull();
  });

  it.each([
    ['zero seed', { amountMinor: 0n, currency: CURRENCY }, 'INVALID_SEED_AMOUNT'],
    ['bad currency', { amountMinor: SEED_MINOR, currency: 'usd' }, 'INVALID_CURRENCY'],
  ])('rejects %s', async (_label, seedOverride, expected) => {
    await expect(
      onboarding.onboardAgent({
        owner: { email: ownerEmail() },
        agentName: 'x',
        objective: { type: 'MAINTAIN', mandate: 'hold' },
        seed: {
          amountMinor: seedOverride.amountMinor,
          currency: seedOverride.currency,
          fundingSourceReference: 'vault_src',
        },
        policy: {
          maxPerTransactionMinor: 100_000n,
          maxDailyBudgetMinor: 300_000n,
          maxMonthlyBudgetMinor: 1_000_000n,
          requireHumanApprovalAboveMinor: 0n,
          allowedRecipients: [RECIPIENT],
          allowedCategories: [MCC],
        },
      })
    ).rejects.toThrow(expected);
  });

  it('rejects an invalid owner email', async () => {
    await expect(
      onboarding.onboardAgent({
        owner: { email: 'not-an-email' },
        agentName: 'x',
        objective: { type: 'MAINTAIN', mandate: 'hold' },
        seed: {
          amountMinor: SEED_MINOR,
          currency: CURRENCY,
          fundingSourceReference: 'vault_src',
        },
        policy: {
          maxPerTransactionMinor: 100_000n,
          maxDailyBudgetMinor: 300_000n,
          maxMonthlyBudgetMinor: 1_000_000n,
          requireHumanApprovalAboveMinor: 0n,
          allowedRecipients: [RECIPIENT],
          allowedCategories: [MCC],
        },
      })
    ).rejects.toThrow('INVALID_OWNER_EMAIL');
  });

  it('marks the seed FUNDING_FAILED when the PayPal balance cannot cover it, leaving the agent unfunded', async () => {
    funding.queueResult({ status: 'INSUFFICIENT_FUNDS' });
    const result = await onboarding.onboardAgent({
      owner: { email: ownerEmail() },
      agentName: 'underfunded',
      objective: { type: 'MAINTAIN', mandate: 'hold' },
      seed: { amountMinor: SEED_MINOR, currency: CURRENCY, fundingSourceReference: 'vault_src' },
      policy: {
        maxPerTransactionMinor: 100_000n,
        maxDailyBudgetMinor: 300_000n,
        maxMonthlyBudgetMinor: 1_000_000n,
        requireHumanApprovalAboveMinor: 0n,
        allowedRecipients: [RECIPIENT],
        allowedCategories: [MCC],
      },
    });

    // Onboarding succeeded durably; the capture fails terminally in the worker.
    expect(await fundingWorker.processNext()).toBe(true);

    const seed = await prisma.seed.findUniqueOrThrow({ where: { id: result.seedId } });
    expect(seed.status).toBe('FUNDING_FAILED');
    const outbox = await prisma.seedFundingOutbox.findUniqueOrThrow({ where: { seedId: result.seedId } });
    expect(outbox.status).toBe('FAILED');
    // The agent exists but can transact with nobody: zero balance, least privilege.
    expect(await new AgentWalletService(prisma).getBalance(result.agentId, CURRENCY)).toBe(0n);
  });

  it('reuses an owner by email, versions the policy, and retires the prior one', async () => {
    const email = ownerEmail();
    const base = {
      owner: { email },
      objective: { type: 'SUSTAIN' as const, mandate: 'run' },
      seed: {
        amountMinor: SEED_MINOR,
        currency: CURRENCY,
        fundingSourceReference: 'vault_src',
      },
      policy: {
        maxPerTransactionMinor: 100_000n,
        maxDailyBudgetMinor: 300_000n,
        maxMonthlyBudgetMinor: 1_000_000n,
        requireHumanApprovalAboveMinor: 0n,
        allowedRecipients: [RECIPIENT],
        allowedCategories: [MCC],
      },
    };

    const first = await onboarding.onboardAgent({ ...base, agentName: 'agent-a' });
    const second = await onboarding.onboardAgent({ ...base, agentName: 'agent-b' });

    expect(second.ownerId).toBe(first.ownerId);
    expect(second.policyVersion).toBe(first.policyVersion + 1);

    const v1 = await prisma.policy.findUniqueOrThrow({
      where: { ownerId_version: { ownerId: first.ownerId, version: 1 } },
    });
    const v2 = await prisma.policy.findUniqueOrThrow({
      where: { ownerId_version: { ownerId: first.ownerId, version: 2 } },
    });
    expect(v1.isActive).toBe(false);
    expect(v2.isActive).toBe(true);

    expect(await prisma.agent.count({ where: { ownerId: first.ownerId } })).toBe(2);
  });
});

describe('OnboardingService.generateAgent', () => {
  it('derives name, mandate, and limits from the objective and seed', async () => {
    const result = await onboarding.generateAgent({
      owner: { email: ownerEmail() },
      objective: { type: 'GROWTH' },
      seed: {
        amountMinor: SEED_MINOR,
        currency: CURRENCY,
        fundingSourceReference: 'vault_gen',
      },
    });

    expect(result.origin).toBe('GENERATED');
    expect(result.objectiveType).toBe('GROWTH');

    const expected = deriveLimitsFromSeed('GROWTH', SEED_MINOR);
    expect(result.derivedPolicy.maxPerTransactionMinor).toBe(expected.maxPerTransactionMinor);
    expect(result.derivedPolicy.maxMonthlyBudgetMinor).toBe(expected.maxMonthlyBudgetMinor);
    // GROWTH: 25% per-tx, 200% monthly of a $10,000 seed.
    expect(result.derivedPolicy.maxPerTransactionMinor).toBe(250_000n);
    expect(result.derivedPolicy.maxMonthlyBudgetMinor).toBe(2_000_000n);

    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: result.agentId } });
    expect(agent.origin).toBe('GENERATED');
    expect(agent.name).toMatch(/^growth-agent-/);
    expect(agent.objectiveMandate).toMatch(/remaining in commission|remain in commission/i);
  });

  it('orders per-transaction autonomy GROWTH > SUSTAIN > MAINTAIN for an identical seed', async () => {
    const growth = await onboarding.generateAgent({
      owner: { email: ownerEmail() },
      objective: { type: 'GROWTH' },
      seed: { amountMinor: SEED_MINOR, currency: CURRENCY, fundingSourceReference: 'v' },
    });
    const sustain = await onboarding.generateAgent({
      owner: { email: ownerEmail() },
      objective: { type: 'SUSTAIN' },
      seed: { amountMinor: SEED_MINOR, currency: CURRENCY, fundingSourceReference: 'v' },
    });
    const maintain = await onboarding.generateAgent({
      owner: { email: ownerEmail() },
      objective: { type: 'MAINTAIN' },
      seed: { amountMinor: SEED_MINOR, currency: CURRENCY, fundingSourceReference: 'v' },
    });

    expect(growth.derivedPolicy.maxPerTransactionMinor).toBeGreaterThan(
      sustain.derivedPolicy.maxPerTransactionMinor
    );
    expect(sustain.derivedPolicy.maxPerTransactionMinor).toBeGreaterThan(
      maintain.derivedPolicy.maxPerTransactionMinor
    );
  });

  it('defaults to an empty allowlist (least privilege): the agent cannot transact until authorized', async () => {
    const result = await onboarding.generateAgent({
      owner: { email: ownerEmail() },
      objective: { type: 'GROWTH' },
      seed: { amountMinor: SEED_MINOR, currency: CURRENCY, fundingSourceReference: 'v' },
    });
    expect(result.derivedPolicy.allowedRecipients).toEqual([]);

    const ledger = new LedgerService(prisma);
    await expect(
      ledger.reserveAndQueuePayment({
        idempotencyKey: `idem_${randomUUID()}`,
        agentId: result.agentId,
        ownerId: result.ownerId,
        recipientId: RECIPIENT,
        merchantCategoryCode: MCC,
        amountMinor: 1_000n,
        currency: CURRENCY,
        paymentMethodRef: 'pm',
      })
    ).rejects.toThrow('RECIPIENT_NOT_ALLOWED');
  });

  it('authorizes payments when generated with an explicit allowlist', async () => {
    const result = await onboarding.generateAgent({
      owner: { email: ownerEmail() },
      objective: { type: 'GROWTH' },
      seed: { amountMinor: SEED_MINOR, currency: CURRENCY, fundingSourceReference: 'v' },
      allowedRecipients: [RECIPIENT],
      allowedCategories: [MCC],
    });

    // Fund the seed through the outbox so the wallet can back the hold.
    await fundingWorker.processNext();

    const ledger = new LedgerService(prisma);
    // GROWTH approval threshold is 25% of seed (250,000); stay under it.
    const payment = await ledger.reserveAndQueuePayment({
      idempotencyKey: `idem_${randomUUID()}`,
      agentId: result.agentId,
      ownerId: result.ownerId,
      recipientId: RECIPIENT,
      merchantCategoryCode: MCC,
      amountMinor: 100_000n,
      currency: CURRENCY,
      paymentMethodRef: 'pm',
    });
    expect(payment.status).toBe(IntentStatus.RESERVED);
  });
});
