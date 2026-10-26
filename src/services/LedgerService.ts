import {
  IntentStatus,
  OutboxEventStatus,
  OutboxEventType,
  PrismaClient,
} from '@prisma/client';
import { ApprovalBinder } from '../security/approvalBinder';
import { AgentWalletService } from './AgentWalletService';

export interface ReserveAndQueuePaymentInput {
  idempotencyKey: string;
  agentId: string;
  ownerId: string;
  recipientId: string;
  merchantCategoryCode: string;
  amountMinor: bigint;
  currency: string;
  paymentMethodRef: string;
  reservationTtlSeconds?: number;
}

export interface PaymentIntentResult {
  intentId: string;
  status: IntentStatus;
  policyVersionApplied: number;
  requiresApproval: boolean;
  replayed: boolean;
}

export class LedgerService {
  private readonly wallet: AgentWalletService;

  constructor(private readonly prisma: PrismaClient) {
    this.wallet = new AgentWalletService(prisma);
  }

  async reserveAndQueuePayment(
    input: ReserveAndQueuePaymentInput
  ): Promise<PaymentIntentResult> {
    this.validateRequest(input);

    // The funds account must exist before the reservation transaction opens, so
    // a concurrent create can't abort it; the hold itself happens inside the tx.
    await this.wallet.ensureAccount(input.agentId, input.currency);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.paymentIntent.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (existing) {
          return this.replayExisting(existing, input);
        }

        const lockedAgents = await tx.$queryRaw<
          Array<{ id: string; isActive: boolean }>
        >`
          SELECT id, "isActive"
          FROM "Agent"
          WHERE id = ${input.agentId} AND "ownerId" = ${input.ownerId}
          FOR UPDATE
        `;

        if (lockedAgents.length === 0) {
          throw new Error('AGENT_NOT_FOUND_OR_UNAUTHORIZED');
        }
        if (!lockedAgents[0].isActive) {
          throw new Error('AGENT_INACTIVE');
        }

        const policy = await tx.policy.findFirst({
          where: {
            ownerId: input.ownerId,
            currency: input.currency,
            isActive: true,
          },
          orderBy: { version: 'desc' },
        });

        if (!policy) {
          throw new Error('NO_ACTIVE_POLICY');
        }
        if (
          policy.maxPerTransactionMinor <= 0n ||
          policy.maxDailyBudgetMinor <= 0n ||
          policy.maxMonthlyBudgetMinor <= 0n ||
          policy.requireHumanApprovalAbove < 0n
        ) {
          throw new Error('INVALID_POLICY_LIMITS');
        }
        if (input.amountMinor > policy.maxPerTransactionMinor) {
          throw new Error('PER_TRANSACTION_LIMIT_EXCEEDED');
        }
        if (!policy.allowedRecipients.includes(input.recipientId)) {
          throw new Error('RECIPIENT_NOT_ALLOWED');
        }
        if (
          !input.merchantCategoryCode ||
          !policy.allowedCategories.includes(input.merchantCategoryCode)
        ) {
          throw new Error('MERCHANT_CATEGORY_NOT_ALLOWED');
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
                agentId: input.agentId,
                currency: input.currency,
                status: IntentStatus.SETTLED,
                createdAt: { gte: startOfDay },
              },
              _sum: { amountMinor: true },
            }),
            tx.paymentIntent.aggregate({
              where: {
                agentId: input.agentId,
                currency: input.currency,
                status: IntentStatus.SETTLED,
                createdAt: { gte: startOfMonth },
              },
              _sum: { amountMinor: true },
            }),
            tx.spendReservation.aggregate({
              where: {
                agentId: input.agentId,
                currency: input.currency,
                status: 'ACTIVE',
              },
              _sum: { amountMinor: true },
            }),
          ]);

        const pending = activeReservations._sum.amountMinor ?? 0n;
        if (
          (dailySettled._sum.amountMinor ?? 0n) + pending + input.amountMinor >
          policy.maxDailyBudgetMinor
        ) {
          throw new Error('DAILY_BUDGET_EXCEEDED');
        }
        if (
          (monthlySettled._sum.amountMinor ?? 0n) +
            pending +
            input.amountMinor >
          policy.maxMonthlyBudgetMinor
        ) {
          throw new Error('MONTHLY_BUDGET_EXCEEDED');
        }

        const requiresApproval =
          input.amountMinor > policy.requireHumanApprovalAbove;
        const intent = await tx.paymentIntent.create({
          data: {
            idempotencyKey: input.idempotencyKey,
            agentId: input.agentId,
            ownerId: input.ownerId,
            recipientId: input.recipientId,
            merchantCategoryCode: input.merchantCategoryCode,
            amountMinor: input.amountMinor,
            currency: input.currency,
            paymentMethodRef: input.paymentMethodRef,
            policyVersionApplied: policy.version,
            status: IntentStatus.CREATED,
          },
        });

        await tx.spendReservation.create({
          data: {
            agentId: input.agentId,
            intentId: intent.id,
            amountMinor: input.amountMinor,
            currency: input.currency,
            status: 'ACTIVE',
            expiresAt: new Date(
              now.getTime() +
                (input.reservationTtlSeconds ?? 300) * 1000
            ),
          },
        });

        // Hold the funds in the agent's wallet (available -> reserved). Fails
        // closed if the balance is insufficient, rolling back the whole
        // reservation. The worker commits this hold on settlement and releases
        // it on failure/cancellation, so the wallet is the single source of
        // truth for funds that actually leave.
        await this.wallet.holdTx(tx, {
          agentId: input.agentId,
          amountMinor: input.amountMinor,
          currency: input.currency,
          intentId: intent.id,
        });

        const status = requiresApproval
          ? IntentStatus.PENDING_APPROVAL
          : IntentStatus.RESERVED;
        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: { status },
        });

        if (!requiresApproval) {
          await tx.outboxEvent.create({
            data: {
              intentId: intent.id,
              type: OutboxEventType.SUBMIT,
              status: OutboxEventStatus.PENDING,
            },
          });
        }

        await tx.auditLog.create({
          data: {
            traceId: intent.id,
            actorId: input.agentId,
            actorType: 'AGENT',
            action: requiresApproval
              ? 'PAYMENT_AWAITING_APPROVAL'
              : 'PAYMENT_RESERVED',
            payload: {
              amountMinor: input.amountMinor.toString(),
              currency: input.currency,
              policyVersion: policy.version,
            },
          },
        });

        return {
          intentId: intent.id,
          status,
          policyVersionApplied: policy.version,
          requiresApproval,
          replayed: false,
        };
      });
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) {
        throw error;
      }

      const existing = await this.prisma.paymentIntent.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (!existing) {
        throw error;
      }
      return this.replayExisting(existing, input);
    }
  }

  async approveAndQueuePayment(
    intentId: string,
    ownerId: string,
    approvalId: string
  ): Promise<PaymentIntentResult> {
    return this.prisma.$transaction(async (tx) => {
      const intent = await tx.paymentIntent.findUnique({
        where: { id: intentId },
      });
      if (!intent || intent.ownerId !== ownerId) {
        throw new Error('INTENT_NOT_FOUND_OR_UNAUTHORIZED');
      }

      if (
        intent.status !== IntentStatus.PENDING_APPROVAL &&
        intent.approvalId === approvalId
      ) {
        return {
          intentId: intent.id,
          status: intent.status,
          policyVersionApplied: intent.policyVersionApplied,
          requiresApproval: false,
          replayed: true,
        };
      }
      if (intent.status !== IntentStatus.PENDING_APPROVAL) {
        throw new Error('INTENT_NOT_AWAITING_APPROVAL');
      }

      const policy = await tx.policy.findFirst({
        where: {
          ownerId,
          currency: intent.currency,
          isActive: true,
        },
        orderBy: { version: 'desc' },
      });
      if (!policy || policy.version !== intent.policyVersionApplied) {
        throw new Error('POLICY_VERSION_STALE');
      }

      const approval = await tx.humanApproval.findFirst({
        where: {
          id: approvalId,
          ownerId,
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
        throw new Error('APPROVAL_INVALID_OR_MISMATCHED');
      }

      const reservation = await tx.spendReservation.findUnique({
        where: { intentId: intent.id },
      });
      if (!reservation || reservation.status !== 'ACTIVE') {
        throw new Error('ACTIVE_RESERVATION_REQUIRED');
      }

      const updated = await tx.paymentIntent.updateMany({
        where: {
          id: intent.id,
          status: IntentStatus.PENDING_APPROVAL,
        },
        data: {
          status: IntentStatus.RESERVED,
          approvalId,
        },
      });
      if (updated.count !== 1) {
        throw new Error('INTENT_STATE_CHANGED');
      }

      await tx.outboxEvent.create({
        data: {
          intentId: intent.id,
          type: OutboxEventType.SUBMIT,
          status: OutboxEventStatus.PENDING,
        },
      });
      await tx.auditLog.create({
        data: {
          traceId: intent.id,
          actorId: ownerId,
          actorType: 'OWNER',
          action: 'PAYMENT_APPROVED',
          payload: {
            approvalId,
            policyVersion: intent.policyVersionApplied,
          },
        },
      });

      return {
        intentId: intent.id,
        status: IntentStatus.RESERVED,
        policyVersionApplied: intent.policyVersionApplied,
        requiresApproval: false,
        replayed: false,
      };
    });
  }

  async commitReservation(intentId: string): Promise<void> {
    await this.prisma.spendReservation.updateMany({
      where: { intentId, status: 'ACTIVE' },
      data: { status: 'COMMITTED' },
    });
  }

  async releaseReservation(intentId: string): Promise<void> {
    await this.prisma.spendReservation.updateMany({
      where: { intentId, status: 'ACTIVE' },
      data: { status: 'RELEASED' },
    });
  }

  private validateRequest(input: ReserveAndQueuePaymentInput): void {
    if (
      !input.idempotencyKey ||
      !input.agentId ||
      !input.ownerId ||
      !input.recipientId ||
      !input.paymentMethodRef ||
      !/^[A-Z]{3}$/.test(input.currency)
    ) {
      throw new Error('INVALID_PAYMENT_REQUEST');
    }
    if (input.amountMinor <= 0n) {
      throw new Error('INVALID_AMOUNT');
    }
    if (
      input.reservationTtlSeconds !== undefined &&
      (!Number.isSafeInteger(input.reservationTtlSeconds) ||
        input.reservationTtlSeconds <= 0)
    ) {
      throw new Error('INVALID_RESERVATION_TTL');
    }
  }

  private replayExisting(
    existing: {
      id: string;
      idempotencyKey: string;
      agentId: string;
      ownerId: string;
      recipientId: string;
      merchantCategoryCode: string | null;
      amountMinor: bigint;
      currency: string;
      paymentMethodRef: string | null;
      policyVersionApplied: number;
      status: IntentStatus;
    },
    input: ReserveAndQueuePaymentInput
  ): PaymentIntentResult {
    if (
      existing.agentId !== input.agentId ||
      existing.ownerId !== input.ownerId ||
      existing.recipientId !== input.recipientId ||
      existing.merchantCategoryCode !== input.merchantCategoryCode ||
      existing.amountMinor !== input.amountMinor ||
      existing.currency !== input.currency ||
      existing.paymentMethodRef !== input.paymentMethodRef
    ) {
      throw new Error('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
    }
    if (existing.status === IntentStatus.CREATED) {
      throw new Error('INTENT_REQUIRES_RECOVERY');
    }

    return {
      intentId: existing.id,
      status: existing.status,
      policyVersionApplied: existing.policyVersionApplied,
      requiresApproval: existing.status === IntentStatus.PENDING_APPROVAL,
      replayed: true,
    };
  }

  private isUniqueConstraintError(
    error: unknown
  ): error is { code: string } {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    );
  }
}
