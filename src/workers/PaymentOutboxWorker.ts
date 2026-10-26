import {
  IntentStatus,
  OutboxEventStatus,
  OutboxEventType,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { IBraintreeGraphQLProvider } from '../providers/braintree/IBraintreeClient';
import { ProviderChargeResult } from '../providers/braintree/types';
import { ApprovalBinder } from '../security/approvalBinder';
import { AgentWalletService } from '../services/AgentWalletService';

type ClaimedEvent = {
  id: string;
  intentId: string;
  type: OutboxEventType;
  attempts: number;
  lockToken: string;
  intent: {
    id: string;
    idempotencyKey: string;
    ownerId: string;
    agentId: string;
    recipientId: string;
    amountMinor: bigint;
    currency: string;
    paymentMethodRef: string | null;
    status: IntentStatus;
    providerTransactionId: string | null;
  };
};

export type PaymentMethodResolver = (
  reference: string
) => Promise<string>;

export interface PaymentOutboxWorkerOptions {
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  reconciliationDelayMs?: number;
}

export class PaymentOutboxWorker {
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly reconciliationDelayMs: number;
  private readonly wallet: AgentWalletService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: IBraintreeGraphQLProvider,
    private readonly resolvePaymentMethod: PaymentMethodResolver,
    options: PaymentOutboxWorkerOptions = {}
  ) {
    this.wallet = new AgentWalletService(prisma);
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.leaseDurationMs = options.leaseDurationMs ?? 30000;
    this.reconciliationDelayMs = options.reconciliationDelayMs ?? 5000;
    if (
      !Number.isSafeInteger(this.pollIntervalMs) ||
      !Number.isSafeInteger(this.leaseDurationMs) ||
      !Number.isSafeInteger(this.reconciliationDelayMs) ||
      this.pollIntervalMs <= 0 ||
      this.leaseDurationMs <= 0 ||
      this.reconciliationDelayMs <= 0
    ) {
      throw new Error('INVALID_WORKER_TIMING_OPTIONS');
    }
  }

  async processNext(): Promise<boolean> {
    const event = await this.claimNext();
    if (!event) {
      return false;
    }

    if (event.type === OutboxEventType.RECONCILE) {
      if (
        event.intent.status !==
        IntentStatus.AMBIGUOUS_PENDING_RECONCILIATION
      ) {
        await this.completeObsoleteEvent(event);
        return true;
      }

      let result: ProviderChargeResult;
      try {
        result = await this.provider.reconcile(event.intent.id);
      } catch {
        await this.scheduleReconciliation(event);
        return true;
      }
      await this.applyProviderResult(event, result);
      return true;
    }

    if (event.intent.status === IntentStatus.RESERVED) {
      const marked = await this.markSubmitting(event);
      if (!marked) {
        return true;
      }
    } else if (event.intent.status === IntentStatus.SUBMITTING) {
      await this.scheduleReconciliation(event);
      return true;
    } else {
      await this.completeObsoleteEvent(event);
      return true;
    }

    if (!event.intent.paymentMethodRef) {
      await this.finishFailure(event, 'PAYMENT_METHOD_REFERENCE_MISSING');
      return true;
    }

    let paymentMethodId: string;
    try {
      paymentMethodId = await this.resolvePaymentMethod(
        event.intent.paymentMethodRef
      );
    } catch {
      await this.retrySubmission(event);
      return true;
    }
    if (!paymentMethodId) {
      await this.retrySubmission(event);
      return true;
    }
    if (!(await this.revalidateBeforeDispatch(event))) {
      return true;
    }

    let result: ProviderChargeResult;
    try {
      result = await this.provider.charge({
        intentId: event.intent.id,
        idempotencyKey: event.intent.idempotencyKey,
        paymentMethodId,
        amountMinor: event.intent.amountMinor,
        currency: event.intent.currency,
      });
    } catch {
      await this.scheduleReconciliation(event);
      return true;
    }

    await this.applyProviderResult(event, result);
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

  private async claimNext(): Promise<ClaimedEvent | null> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - this.leaseDurationMs);
    const lockToken = randomUUID();

    return this.prisma.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM "OutboxEvent"
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

      const event = await tx.outboxEvent.update({
        where: { id: candidates[0].id },
        data: {
          status: OutboxEventStatus.PROCESSING,
          lockedAt: now,
          lockToken,
          attempts: { increment: 1 },
        },
        include: { intent: true },
      });

      return {
        ...event,
        lockToken,
      };
    });
  }

  private async markSubmitting(event: ClaimedEvent): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const ownsLease = await tx.outboxEvent.findFirst({
        where: {
          id: event.id,
          status: OutboxEventStatus.PROCESSING,
          lockToken: event.lockToken,
        },
      });
      if (!ownsLease) {
        return false;
      }

      const intent = await tx.paymentIntent.findUnique({
        where: { id: event.intentId },
      });
      if (!intent || intent.status !== IntentStatus.RESERVED) {
        return false;
      }
      const failureReason = await this.authorizationFailure(tx, intent);
      if (failureReason) {
        await this.cancelUnsentPayment(tx, event, failureReason);
        return false;
      }

      const updated = await tx.paymentIntent.updateMany({
        where: {
          id: event.intentId,
          status: IntentStatus.RESERVED,
        },
        data: { status: IntentStatus.SUBMITTING },
      });
      return updated.count === 1;
    });
  }

  private async revalidateBeforeDispatch(event: ClaimedEvent): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const ownsLease = await tx.outboxEvent.findFirst({
        where: {
          id: event.id,
          status: OutboxEventStatus.PROCESSING,
          lockToken: event.lockToken,
        },
      });
      if (!ownsLease) {
        return false;
      }

      const intent = await tx.paymentIntent.findUnique({
        where: { id: event.intentId },
      });
      if (!intent || intent.status !== IntentStatus.SUBMITTING) {
        return false;
      }
      const failureReason = await this.authorizationFailure(tx, intent);
      if (!failureReason) {
        return true;
      }
      await this.cancelUnsentPayment(tx, event, failureReason);
      return false;
    });
  }

  private async authorizationFailure(
    tx: Prisma.TransactionClient,
    intent: {
      id: string;
      ownerId: string;
      agentId: string;
      recipientId: string;
      merchantCategoryCode: string | null;
      amountMinor: bigint;
      currency: string;
      policyVersionApplied: number;
      approvalId: string | null;
    }
  ): Promise<string | null> {
    const agents = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "Agent"
      WHERE id = ${intent.agentId}
        AND "ownerId" = ${intent.ownerId}
        AND "isActive" = true
      FOR UPDATE
    `;
    if (agents.length === 0) {
      return 'AGENT_INACTIVE_OR_UNAUTHORIZED';
    }

    const policy = await tx.policy.findFirst({
      where: {
        ownerId: intent.ownerId,
        currency: intent.currency,
        isActive: true,
      },
      orderBy: { version: 'desc' },
    });
    if (!policy || policy.version !== intent.policyVersionApplied) {
      return 'POLICY_VERSION_STALE';
    }
    if (
      policy.maxPerTransactionMinor <= 0n ||
      policy.maxDailyBudgetMinor <= 0n ||
      policy.maxMonthlyBudgetMinor <= 0n ||
      policy.requireHumanApprovalAbove < 0n ||
      intent.amountMinor > policy.maxPerTransactionMinor
    ) {
      return 'POLICY_LIMITS_INVALID_OR_EXCEEDED';
    }
    if (!policy.allowedRecipients.includes(intent.recipientId)) {
      return 'RECIPIENT_NOT_ALLOWED';
    }
    if (
      !intent.merchantCategoryCode ||
      !policy.allowedCategories.includes(intent.merchantCategoryCode)
    ) {
      return 'MERCHANT_CATEGORY_NOT_ALLOWED';
    }
    if (intent.amountMinor > policy.requireHumanApprovalAbove) {
      if (!intent.approvalId) {
        return 'HUMAN_APPROVAL_REQUIRED';
      }
      const approval = await tx.humanApproval.findFirst({
        where: {
          id: intent.approvalId,
          ownerId: intent.ownerId,
          policyVersion: intent.policyVersionApplied,
        },
      });
      if (
        !approval ||
        !ApprovalBinder.verifyFingerprint(approval.fingerprint, {
          intentId: intent.id,
          recipientId: intent.recipientId,
          amountMinor: intent.amountMinor,
          currency: intent.currency,
          policyVersion: intent.policyVersionApplied,
        })
      ) {
        return 'APPROVAL_INVALID_OR_MISMATCHED';
      }
    }

    const now = new Date();
    const startOfDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
    const startOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    );
    const [dailySettled, monthlySettled, activeReservations] =
      await Promise.all([
        tx.paymentIntent.aggregate({
          where: {
            agentId: intent.agentId,
            currency: intent.currency,
            status: IntentStatus.SETTLED,
            createdAt: { gte: startOfDay },
          },
          _sum: { amountMinor: true },
        }),
        tx.paymentIntent.aggregate({
          where: {
            agentId: intent.agentId,
            currency: intent.currency,
            status: IntentStatus.SETTLED,
            createdAt: { gte: startOfMonth },
          },
          _sum: { amountMinor: true },
        }),
        tx.spendReservation.aggregate({
          where: {
            agentId: intent.agentId,
            currency: intent.currency,
            status: 'ACTIVE',
          },
          _sum: { amountMinor: true },
        }),
      ]);
    const pending = activeReservations._sum.amountMinor ?? 0n;
    if (
      (dailySettled._sum.amountMinor ?? 0n) + pending >
      policy.maxDailyBudgetMinor
    ) {
      return 'DAILY_BUDGET_EXCEEDED';
    }
    if (
      (monthlySettled._sum.amountMinor ?? 0n) + pending >
      policy.maxMonthlyBudgetMinor
    ) {
      return 'MONTHLY_BUDGET_EXCEEDED';
    }

    return null;
  }

  private async cancelUnsentPayment(
    tx: Prisma.TransactionClient,
    event: ClaimedEvent,
    reason: string
  ): Promise<void> {
    const completed = await tx.outboxEvent.updateMany({
      where: {
        id: event.id,
        status: OutboxEventStatus.PROCESSING,
        lockToken: event.lockToken,
      },
      data: {
        status: OutboxEventStatus.COMPLETED,
        lockedAt: null,
        lockToken: null,
        lastError: reason,
      },
    });
    if (completed.count !== 1) {
      throw new Error('OUTBOX_LEASE_LOST_DURING_CANCELLATION');
    }

    const cancelled = await tx.paymentIntent.updateMany({
      where: {
        id: event.intentId,
        status: {
          in: [IntentStatus.RESERVED, IntentStatus.SUBMITTING],
        },
      },
      data: {
        status: IntentStatus.CANCELLED,
        failureReason: reason,
      },
    });
    if (cancelled.count !== 1) {
      throw new Error('INTENT_STATE_CHANGED_DURING_CANCELLATION');
    }

    const reservation = await tx.spendReservation.updateMany({
      where: { intentId: event.intentId, status: 'ACTIVE' },
      data: { status: 'RELEASED' },
    });
    if (reservation.count !== 1) {
      throw new Error('ACTIVE_RESERVATION_REQUIRED_FOR_CANCELLATION');
    }

    // Cancelled before submission: release the hold back to spendable balance.
    await this.wallet.releaseHoldTx(tx, {
      agentId: event.intent.agentId,
      amountMinor: event.intent.amountMinor,
      currency: event.intent.currency,
      intentId: event.intentId,
    });

    await tx.auditLog.create({
      data: {
        traceId: event.intentId,
        actorId: 'payment-outbox-worker',
        actorType: 'SYSTEM',
        action: 'PAYMENT_CANCELLED_BEFORE_SUBMISSION',
        payload: { reason },
      },
    });
  }

  private async applyProviderResult(
    event: ClaimedEvent,
    result: ProviderChargeResult
  ): Promise<void> {
    if (result.status === 'AMBIGUOUS') {
      await this.scheduleReconciliation(event);
      return;
    }
    if (result.status === 'DECLINED') {
      await this.finishFailure(event, result.reason);
      return;
    }
    if (
      result.amountSettledMinor !== event.intent.amountMinor ||
      result.currency.toUpperCase() !== event.intent.currency.toUpperCase()
    ) {
      await this.scheduleReconciliation(event);
      return;
    }

    await this.finishSuccess(event, result.transactionId);
  }

  private async finishSuccess(
    event: ClaimedEvent,
    providerTransactionId: string
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const ownsLease = await tx.outboxEvent.updateMany({
        where: {
          id: event.id,
          status: OutboxEventStatus.PROCESSING,
          lockToken: event.lockToken,
        },
        data: {
          status: OutboxEventStatus.COMPLETED,
          lockedAt: null,
          lockToken: null,
          lastError: null,
        },
      });
      if (ownsLease.count !== 1) {
        return;
      }

      const updated = await tx.paymentIntent.updateMany({
        where: {
          id: event.intentId,
          status: {
            in: [
              IntentStatus.SUBMITTING,
              IntentStatus.AMBIGUOUS_PENDING_RECONCILIATION,
            ],
          },
        },
        data: {
          status: IntentStatus.SETTLED,
          providerTransactionId,
          failureReason: null,
        },
      });
      if (updated.count !== 1) {
        throw new Error('INTENT_STATE_CHANGED_BEFORE_SETTLEMENT');
      }

      const reservation = await tx.spendReservation.updateMany({
        where: { intentId: event.intentId, status: 'ACTIVE' },
        data: { status: 'COMMITTED' },
      });
      if (reservation.count !== 1) {
        throw new Error('ACTIVE_RESERVATION_REQUIRED_FOR_SETTLEMENT');
      }

      // Funds committed: reserved -> out in the agent's wallet.
      await this.wallet.commitHoldTx(tx, {
        agentId: event.intent.agentId,
        amountMinor: event.intent.amountMinor,
        currency: event.intent.currency,
        intentId: event.intentId,
      });

      await tx.auditLog.create({
        data: {
          traceId: event.intentId,
          actorId: 'payment-outbox-worker',
          actorType: 'SYSTEM',
          action: 'PAYMENT_SETTLED',
          payload: { providerTransactionId },
        },
      });
    });
  }

  private async finishFailure(
    event: ClaimedEvent,
    reason: string
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const ownsLease = await tx.outboxEvent.updateMany({
        where: {
          id: event.id,
          status: OutboxEventStatus.PROCESSING,
          lockToken: event.lockToken,
        },
        data: {
          status: OutboxEventStatus.COMPLETED,
          lockedAt: null,
          lockToken: null,
          lastError: null,
        },
      });
      if (ownsLease.count !== 1) {
        return;
      }

      const updated = await tx.paymentIntent.updateMany({
        where: {
          id: event.intentId,
          status: {
            in: [
              IntentStatus.SUBMITTING,
              IntentStatus.AMBIGUOUS_PENDING_RECONCILIATION,
            ],
          },
        },
        data: {
          status: IntentStatus.FAILED,
          failureReason: reason.slice(0, 500),
        },
      });
      if (updated.count !== 1) {
        throw new Error('INTENT_STATE_CHANGED_BEFORE_FAILURE');
      }

      const reservation = await tx.spendReservation.updateMany({
        where: { intentId: event.intentId, status: 'ACTIVE' },
        data: { status: 'RELEASED' },
      });
      if (reservation.count !== 1) {
        throw new Error('ACTIVE_RESERVATION_REQUIRED_FOR_FAILURE');
      }

      // Payment did not settle: release the hold back to spendable balance.
      await this.wallet.releaseHoldTx(tx, {
        agentId: event.intent.agentId,
        amountMinor: event.intent.amountMinor,
        currency: event.intent.currency,
        intentId: event.intentId,
      });

      await tx.auditLog.create({
        data: {
          traceId: event.intentId,
          actorId: 'payment-outbox-worker',
          actorType: 'SYSTEM',
          action: 'PAYMENT_FAILED',
          payload: { reason: reason.slice(0, 500) },
        },
      });
    });
  }

  private async scheduleReconciliation(event: ClaimedEvent): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const ownsLease = await tx.outboxEvent.updateMany({
        where: {
          id: event.id,
          status: OutboxEventStatus.PROCESSING,
          lockToken: event.lockToken,
        },
        data: {
          type: OutboxEventType.RECONCILE,
          status: OutboxEventStatus.PENDING,
          availableAt: new Date(
            Date.now() + this.retryDelay(event.attempts)
          ),
          lockedAt: null,
          lockToken: null,
          lastError: 'PROVIDER_OUTCOME_AMBIGUOUS',
        },
      });
      if (ownsLease.count !== 1) {
        return;
      }

      const updated = await tx.paymentIntent.updateMany({
        where: {
          id: event.intentId,
          status: {
            in: [
              IntentStatus.SUBMITTING,
              IntentStatus.AMBIGUOUS_PENDING_RECONCILIATION,
            ],
          },
        },
        data: { status: IntentStatus.AMBIGUOUS_PENDING_RECONCILIATION },
      });
      if (updated.count !== 1) {
        throw new Error('INTENT_STATE_CHANGED_DURING_RECONCILIATION');
      }

      await tx.auditLog.create({
        data: {
          traceId: event.intentId,
          actorId: 'payment-outbox-worker',
          actorType: 'RECONCILIATION_WORKER',
          action: 'PAYMENT_REQUIRES_RECONCILIATION',
          payload: { attempt: event.attempts },
        },
      });
    });
  }

  private async retrySubmission(event: ClaimedEvent): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const ownsLease = await tx.outboxEvent.updateMany({
        where: {
          id: event.id,
          status: OutboxEventStatus.PROCESSING,
          lockToken: event.lockToken,
        },
        data: {
          type: OutboxEventType.SUBMIT,
          status: OutboxEventStatus.PENDING,
          availableAt: new Date(Date.now() + this.retryDelay(event.attempts)),
          lockedAt: null,
          lockToken: null,
          lastError: 'PAYMENT_METHOD_RESOLUTION_FAILED',
        },
      });
      if (ownsLease.count !== 1) {
        return;
      }

      const updated = await tx.paymentIntent.updateMany({
        where: {
          id: event.intentId,
          status: IntentStatus.SUBMITTING,
        },
        data: { status: IntentStatus.RESERVED },
      });
      if (updated.count !== 1) {
        throw new Error('INTENT_STATE_CHANGED_DURING_PAYMENT_METHOD_RESOLUTION');
      }

      await tx.auditLog.create({
        data: {
          traceId: event.intentId,
          actorId: 'payment-outbox-worker',
          actorType: 'SYSTEM',
          action: 'PAYMENT_METHOD_RESOLUTION_RETRY',
          payload: { attempt: event.attempts },
        },
      });
    });
  }

  private async completeObsoleteEvent(event: ClaimedEvent): Promise<void> {
    await this.prisma.outboxEvent.updateMany({
      where: {
        id: event.id,
        status: OutboxEventStatus.PROCESSING,
        lockToken: event.lockToken,
      },
      data: {
        status: OutboxEventStatus.COMPLETED,
        lockedAt: null,
        lockToken: null,
      },
    });
  }

  private retryDelay(attempt: number): number {
    return Math.min(
      this.reconciliationDelayMs * 2 ** Math.min(attempt - 1, 8),
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
