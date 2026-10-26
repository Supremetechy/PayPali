import { PGlite } from '@electric-sql/pglite';
import { PrismaClient, IntentStatus, OutboxEventType, OutboxEventStatus, SeedFundingStatus } from '@prisma/client';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { IBraintreeGraphQLProvider } from '../src/providers/braintree/IBraintreeClient';
import { ChargeParams, ProviderChargeResult } from '../src/providers/braintree/types';
import {
  IPayPalFundingGateway,
  SeedFundingRequest,
  SeedFundingResult,
} from '../src/providers/paypal/IPayPalFundingGateway';

const SCHEMA_SQL = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '.generated/schema.sql'),
  'utf8'
);

export interface TestDb {
  prisma: PrismaClient;
  pglite: PGlite;
  close: () => Promise<void>;
}

/** Fresh in-process Postgres (PGlite) with the full datamodel applied. */
export async function createTestDb(): Promise<TestDb> {
  const pglite = new PGlite();
  await pglite.exec(SCHEMA_SQL);
  // pglite-prisma-adapter@0.6.x ships its own copy of @prisma/driver-adapter-utils,
  // so its factory type is nominally distinct from the one @prisma/client expects.
  // The shapes are identical and verified at runtime by this suite; cast at the seam.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter = new PrismaPGlite(pglite) as any;
  const prisma = new PrismaClient({ adapter });
  return {
    prisma,
    pglite,
    close: async () => {
      await prisma.$disconnect();
      await pglite.close();
    },
  };
}

/**
 * Programmable Braintree double. `charge`/`reconcile` pull from a queue of
 * outcomes (or a thrown error); every call is recorded for assertions.
 */
export class FakeBraintreeProvider implements IBraintreeGraphQLProvider {
  readonly chargeCalls: ChargeParams[] = [];
  readonly reconcileCalls: string[] = [];
  private chargeQueue: Array<ProviderChargeResult | Error> = [];
  private reconcileQueue: Array<ProviderChargeResult | Error> = [];

  queueCharge(...outcomes: Array<ProviderChargeResult | Error>): this {
    this.chargeQueue.push(...outcomes);
    return this;
  }
  queueReconcile(...outcomes: Array<ProviderChargeResult | Error>): this {
    this.reconcileQueue.push(...outcomes);
    return this;
  }

  async charge(params: ChargeParams): Promise<ProviderChargeResult> {
    this.chargeCalls.push(params);
    return this.take(this.chargeQueue, 'charge');
  }
  async reconcile(intentId: string): Promise<ProviderChargeResult> {
    this.reconcileCalls.push(intentId);
    return this.take(this.reconcileQueue, 'reconcile');
  }

  private take(
    queue: Array<ProviderChargeResult | Error>,
    label: string
  ): ProviderChargeResult {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`FakeBraintreeProvider.${label} called with empty queue`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

/**
 * Programmable PayPal funding double. Captures from the owner's PayPal balance
 * succeed by default; queue results to exercise insufficient-balance/failure.
 */
export class FakePayPalFundingGateway implements IPayPalFundingGateway {
  readonly captureCalls: SeedFundingRequest[] = [];
  private results: Array<SeedFundingResult | Error> = [];
  // Idempotent by key, like PayPal: a repeated key returns the first outcome.
  private readonly byKey = new Map<string, SeedFundingResult>();

  queueResult(...outcomes: Array<SeedFundingResult | Error>): this {
    this.results.push(...outcomes);
    return this;
  }

  async captureFromBalance(request: SeedFundingRequest): Promise<SeedFundingResult> {
    this.captureCalls.push(request);
    const cached = this.byKey.get(request.idempotencyKey);
    if (cached) {
      return cached;
    }
    const next = this.results.shift();
    if (next instanceof Error) {
      throw next; // not cached: an unknown outcome may still have captured
    }
    const result = next ?? { status: 'CAPTURED', captureId: `cap_${randomUUID()}` };
    this.byKey.set(request.idempotencyKey, result);
    return result;
  }
}

export function success(
  amountMinor: bigint,
  currency: string,
  transactionId = `txn_${randomUUID()}`
): ProviderChargeResult {
  return {
    status: 'SUCCESS',
    transactionId,
    providerStatus: 'SETTLED',
    amountSettledMinor: amountMinor,
    currency,
    rawResponse: {},
  };
}

export function declined(reason = 'DECLINED'): ProviderChargeResult {
  return { status: 'DECLINED', reason, rawResponse: {} };
}

export function ambiguous(reason = 'TIMEOUT'): ProviderChargeResult {
  return {
    status: 'AMBIGUOUS',
    reason,
    error: new Error(reason),
    requiresReconciliation: true,
  };
}

export interface SeedResult {
  ownerId: string;
  agentId: string;
  policyVersion: number;
}

/** Wallet balance the seed helper funds its agent with, so merchant holds clear. */
export const SEEDED_WALLET_MINOR = 1_000_000_000n;

/** One owner + one active agent + one permissive active policy + a funded wallet. */
export async function seedOwnerAgentPolicy(
  prisma: PrismaClient,
  opts: {
    currency?: string;
    recipientId: string;
    merchantCategoryCode: string;
    requireHumanApprovalAbove?: bigint;
  }
): Promise<SeedResult> {
  const currency = opts.currency ?? 'USD';
  const owner = await prisma.owner.create({
    data: { email: `owner_${randomUUID()}@example.com` },
  });
  const agent = await prisma.agent.create({
    data: { ownerId: owner.id, name: 'test-agent', isActive: true },
  });
  await prisma.agentAccount.create({
    data: { agentId: agent.id, currency, availableMinor: SEEDED_WALLET_MINOR },
  });
  const policy = await prisma.policy.create({
    data: {
      ownerId: owner.id,
      version: 1,
      currency,
      maxPerTransactionMinor: 1_000_000n,
      maxDailyBudgetMinor: 10_000_000n,
      maxMonthlyBudgetMinor: 100_000_000n,
      requireHumanApprovalAbove: opts.requireHumanApprovalAbove ?? 1_000_000n,
      allowedRecipients: [opts.recipientId],
      allowedCategories: [opts.merchantCategoryCode],
      isActive: true,
    },
  });
  return { ownerId: owner.id, agentId: agent.id, policyVersion: policy.version };
}

/**
 * Forces a claimed outbox event into the "a worker marked SUBMITTING then died
 * mid-dispatch" state: intent = SUBMITTING, event = PROCESSING with a stale
 * lease held by some other worker token.
 */
export async function simulateStaleSubmitting(
  prisma: PrismaClient,
  intentId: string,
  leaseDurationMs: number
): Promise<void> {
  await prisma.paymentIntent.update({
    where: { id: intentId },
    data: { status: IntentStatus.SUBMITTING },
  });
  await prisma.outboxEvent.update({
    where: { intentId },
    data: {
      type: OutboxEventType.SUBMIT,
      status: OutboxEventStatus.PROCESSING,
      lockedAt: new Date(Date.now() - leaseDurationMs - 60_000),
      lockToken: 'dead-worker-token',
      attempts: 1,
    },
  });
}

/** Makes a PENDING event immediately claimable (clears any future availableAt). */
export async function makeClaimable(
  prisma: PrismaClient,
  intentId: string
): Promise<void> {
  await prisma.outboxEvent.update({
    where: { intentId },
    data: { availableAt: new Date(Date.now() - 1000) },
  });
}

/**
 * Simulates a seed-funding worker that claimed a job then died mid-capture: the
 * outbox row is PROCESSING with a stale lease held by some other token, while
 * the seed is still AUTHORIZED (the capture never committed).
 */
export async function simulateStaleSeedFunding(
  prisma: PrismaClient,
  seedId: string,
  leaseDurationMs: number
): Promise<void> {
  await prisma.seedFundingOutbox.update({
    where: { seedId },
    data: {
      status: SeedFundingStatus.PROCESSING,
      lockedAt: new Date(Date.now() - leaseDurationMs - 60_000),
      lockToken: 'dead-worker-token',
      attempts: 1,
    },
  });
}
