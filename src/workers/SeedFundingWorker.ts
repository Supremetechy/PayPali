import {
  LedgerDirection,
  LedgerEntryType,
  Prisma,
  PrismaClient,
  SeedFundingStatus,
  SeedStatus,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { IPayPalFundingGateway } from '../providers/paypal/IPayPalFundingGateway';

// Drains the SeedFundingOutbox: for each queued seed it captures the amount from
// the owner's PayPal balance and credits the agent's wallet. Crash-safe by the
// same lease + idempotency discipline as PaymentOutboxWorker — a process that
// dies mid-capture leaves a PROCESSING row whose lease expires and is reclaimed,
// and the capture replays under the seed's stable idempotency key, so the PayPal
// balance is pulled at most once and the wallet is credited at most once.

type ClaimedFundingEvent = {
  id: string;
  seedId: string;
  attempts: number;
  lockToken: string;
  captureIdempotencyKey: string;
  seed: {
    id: string;
    ownerId: string;
    agentId: string;
    amountMinor: bigint;
    currency: string;
    status: SeedStatus;
    fundingSourceReference: string;
  };
};

export interface SeedFundingWorkerOptions {
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  retryBaseMs?: number;
  maxAttempts?: number;
}

export class SeedFundingWorker {
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly retryBaseMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly funding: IPayPalFundingGateway,
    options: SeedFundingWorkerOptions = {}
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.leaseDurationMs = options.leaseDurationMs ?? 30000;
    this.retryBaseMs = options.retryBaseMs ?? 5000;
    this.maxAttempts = options.maxAttempts ?? 5;
    if (
      !Number.isSafeInteger(this.pollIntervalMs) ||
      !Number.isSafeInteger(this.leaseDurationMs) ||
      !Number.isSafeInteger(this.retryBaseMs) ||
      !Number.isSafeInteger(this.maxAttempts) ||
      this.pollIntervalMs <= 0 ||
      this.leaseDurationMs <= 0 ||
      this.retryBaseMs <= 0 ||
      this.maxAttempts <= 0
    ) {
      throw new Error('INVALID_WORKER_TIMING_OPTIONS');
    }
  }

  async processNext(): Promise<boolean> {
    const event = await this.claimNext();
    if (!event) {
      return false;
    }

    // Seed already resolved (funded or failed) by an earlier attempt: close out.
    if (event.seed.status !== SeedStatus.AUTHORIZED) {
      await this.completeObsolete(event);
      return true;
    }

    let result;
    try {
      result = await this.funding.captureFromBalance({
        ownerId: event.seed.ownerId,
        fundingSourceReference: event.seed.fundingSourceReference,
        amountMinor: event.seed.amountMinor,
        currency: event.seed.currency,
        idempotencyKey: event.captureIdempotencyKey,
      });
    } catch {
      // Unknown outcome (e.g. timeout): retry under the same idempotency key.
      await this.retryOrFail(event, 'PAYPAL_CAPTURE_ERROR');
      return true;
    }

    if (result.status === 'CAPTURED') {
      await this.finishFunded(event, result.captureId);
    } else if (result.status === 'INSUFFICIENT_FUNDS') {
      await this.failTerminal(event, 'INSUFFICIENT_PAYPAL_BALANCE');
    } else {
      await this.retryOrFail(event, result.reason);
    }
    return true;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const didWork = await this.processNext();
      if (!didWork) {
        await this.waitForPoll(signal);
      }
    }
  }

  private async claimNext(): Promise<ClaimedFundingEvent | null> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - this.leaseDurationMs);
    const lockToken = randomUUID();

    return this.prisma.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM "SeedFundingOutbox"
        WHERE (
          "status" = 'PENDING' AND "availableAt" <= ${now}
        ) OR (
          "status" = 'PROCESSING' AND "lockedAt" <= ${staleBefore}
        )
        ORDER BY "availableAt" ASC, "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
      if (candidates.length === 0) {
        return null;
      }

      const event = await tx.seedFundingOutbox.update({
        where: { id: candidates[0].id },
        data: {
          status: SeedFundingStatus.PROCESSING,
          lockedAt: now,
          lockToken,
          attempts: { increment: 1 },
        },
        include: { seed: true },
      });

      return { ...event, lockToken } as ClaimedFundingEvent;
    });
  }

  private async finishFunded(
    event: ClaimedFundingEvent,
    captureId: string
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const ownsLease = await tx.seedFundingOutbox.updateMany({
        where: {
          id: event.id,
          status: SeedFundingStatus.PROCESSING,
          lockToken: event.lockToken,
        },
        data: {
          status: SeedFundingStatus.COMPLETED,
          lockedAt: null,
          lockToken: null,
          lastError: null,
        },
      });
      if (ownsLease.count !== 1) {
        return; // lease lost to a reclaiming worker; it will finish the job
      }

      const seedUpdated = await tx.seed.updateMany({
        where: { id: event.seedId, status: SeedStatus.AUTHORIZED },
        data: { status: SeedStatus.CONSUMED, fundingCaptureId: captureId },
      });
      if (seedUpdated.count !== 1) {
        throw new Error('SEED_STATE_CHANGED_DURING_FUNDING');
      }

      // Credit the captured seed into the agent's wallet. The SEED_FUNDING
      // ledger entry's unique idempotency key makes a double credit impossible.
      const [account] = await tx.$queryRaw<
        Array<{ id: string; availableMinor: bigint }>
      >`
        SELECT id, "availableMinor"
        FROM "AgentAccount"
        WHERE "agentId" = ${event.seed.agentId} AND currency = ${event.seed.currency}
        FOR UPDATE
      `;
      if (!account) {
        throw new Error('AGENT_ACCOUNT_MISSING');
      }
      const newBalance = account.availableMinor + event.seed.amountMinor;
      await tx.agentAccount.update({
        where: { id: account.id },
        data: { availableMinor: newBalance },
      });
      await tx.ledgerEntry.create({
        data: {
          accountId: account.id,
          agentId: event.seed.agentId,
          currency: event.seed.currency,
          direction: LedgerDirection.CREDIT,
          amountMinor: event.seed.amountMinor,
          type: LedgerEntryType.SEED_FUNDING,
          balanceAfterMinor: newBalance,
          idempotencyKey: `seed:${event.seedId}`,
        },
      });

      await tx.auditLog.create({
        data: {
          traceId: event.seed.agentId,
          actorId: 'seed-funding-worker',
          actorType: 'SYSTEM',
          action: 'SEED_FUNDED',
          payload: {
            seedId: event.seedId,
            captureId,
            amountMinor: event.seed.amountMinor.toString(),
            currency: event.seed.currency,
            balanceAfterMinor: newBalance.toString(),
          },
        },
      });
    });
  }

  private async failTerminal(
    event: ClaimedFundingEvent,
    reason: string
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const ownsLease = await tx.seedFundingOutbox.updateMany({
        where: {
          id: event.id,
          status: SeedFundingStatus.PROCESSING,
          lockToken: event.lockToken,
        },
        data: {
          status: SeedFundingStatus.FAILED,
          lockedAt: null,
          lockToken: null,
          lastError: reason.slice(0, 500),
        },
      });
      if (ownsLease.count !== 1) {
        return;
      }

      await tx.seed.updateMany({
        where: { id: event.seedId, status: SeedStatus.AUTHORIZED },
        data: { status: SeedStatus.FUNDING_FAILED },
      });

      await tx.auditLog.create({
        data: {
          traceId: event.seed.agentId,
          actorId: 'seed-funding-worker',
          actorType: 'SYSTEM',
          action: 'SEED_FUNDING_FAILED',
          payload: { seedId: event.seedId, reason: reason.slice(0, 500) },
        },
      });
    });
  }

  private async retryOrFail(
    event: ClaimedFundingEvent,
    reason: string
  ): Promise<void> {
    if (event.attempts >= this.maxAttempts) {
      await this.failTerminal(event, `${reason} (max attempts reached)`);
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.seedFundingOutbox.updateMany({
        where: {
          id: event.id,
          status: SeedFundingStatus.PROCESSING,
          lockToken: event.lockToken,
        },
        data: {
          status: SeedFundingStatus.PENDING,
          availableAt: new Date(Date.now() + this.retryDelay(event.attempts)),
          lockedAt: null,
          lockToken: null,
          lastError: reason.slice(0, 500),
        },
      });
    });
  }

  private async completeObsolete(event: ClaimedFundingEvent): Promise<void> {
    await this.prisma.seedFundingOutbox.updateMany({
      where: {
        id: event.id,
        status: SeedFundingStatus.PROCESSING,
        lockToken: event.lockToken,
      },
      data: {
        status: SeedFundingStatus.COMPLETED,
        lockedAt: null,
        lockToken: null,
      },
    });
  }

  private retryDelay(attempt: number): number {
    return Math.min(
      this.retryBaseMs * 2 ** Math.min(attempt - 1, 8),
      15 * 60 * 1000
    );
  }

  private async waitForPoll(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, this.pollIntervalMs);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
}
