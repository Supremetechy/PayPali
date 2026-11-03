import {
  LedgerDirection,
  LedgerEntryType,
  Prisma,
  PrismaClient,
} from '@prisma/client';

// ---------------------------------------------------------------------------
// The agent money-movement layer: receive, spend, send.
//
// Every operation mutates an agent's AgentAccount balance under a row lock
// (SELECT ... FOR UPDATE), writes an append-only LedgerEntry snapshotting the
// resulting balance, and records an audit event. Money movements are
// idempotent: receive/spend dedupe on LedgerEntry.idempotencyKey, send dedupes
// on AgentTransfer.idempotencyKey. Fail-closed throughout — an invalid request,
// an inactive agent, or an insufficient balance aborts before any write.
// ---------------------------------------------------------------------------

/** Receive sources an owner/platform may credit an agent from. */
export type ReceiveType = Extract<
  LedgerEntryType,
  'SEED_FUNDING' | 'EXTERNAL_TOPUP' | 'REFUND'
>;

export interface ReceiveInput {
  agentId: string;
  amountMinor: bigint;
  currency: string;
  idempotencyKey: string;
  type?: ReceiveType; // defaults to EXTERNAL_TOPUP
  relatedIntentId?: string;
}

export interface SpendInput {
  agentId: string;
  amountMinor: bigint;
  currency: string;
  idempotencyKey: string;
  relatedIntentId?: string;
}

export interface SendInput {
  fromAgentId: string;
  toAgentId: string;
  amountMinor: bigint;
  currency: string;
  idempotencyKey: string;
}

/** A merchant payment's hold lifecycle leg, keyed by its PaymentIntent id. */
export interface MerchantHoldInput {
  agentId: string;
  amountMinor: bigint;
  currency: string;
  intentId: string;
}

export interface WalletMovementResult {
  entryId: string;
  agentId: string;
  direction: LedgerDirection;
  amountMinor: bigint;
  balanceAfterMinor: bigint;
  currency: string;
  type: LedgerEntryType;
  replayed: boolean;
}

export interface SendResult {
  transferId: string;
  fromBalanceAfterMinor: bigint;
  toBalanceAfterMinor: bigint;
  amountMinor: bigint;
  currency: string;
  replayed: boolean;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class AgentWalletService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Current spendable balance for an agent + currency (0 if no account yet). */
  async getBalance(agentId: string, currency: string): Promise<bigint> {
    this.assertCurrency(currency);
    const account = await this.prisma.agentAccount.findUnique({
      where: { agentId_currency: { agentId, currency } },
    });
    return account?.availableMinor ?? 0n;
  }

  /** Funds held against in-flight merchant payments (0 if no account yet). */
  async getReserved(agentId: string, currency: string): Promise<bigint> {
    this.assertCurrency(currency);
    const account = await this.prisma.agentAccount.findUnique({
      where: { agentId_currency: { agentId, currency } },
    });
    return account?.reservedMinor ?? 0n;
  }

  // -------------------------------------------------------------------------
  // Merchant settlement hooks (available <-> reserved <-> out).
  //
  // These run INSIDE the caller's transaction (LedgerService at reservation,
  // PaymentOutboxWorker at settlement/failure) so a payment's budget reservation
  // and its funds hold move together. The account must already exist — the
  // caller runs ensureAccount() before opening its transaction.
  // -------------------------------------------------------------------------

  /** Reserve funds for a merchant payment: available -> reserved. Fails closed. */
  async holdTx(tx: Prisma.TransactionClient, p: MerchantHoldInput): Promise<void> {
    const account = await this.lockAccountTx(tx, p.agentId, p.currency);
    if (account.availableMinor < p.amountMinor) {
      throw new Error('INSUFFICIENT_FUNDS');
    }
    const available = account.availableMinor - p.amountMinor;
    const reserved = account.reservedMinor + p.amountMinor;
    await tx.agentAccount.update({
      where: { id: account.id },
      data: { availableMinor: available, reservedMinor: reserved },
    });
    await tx.ledgerEntry.create({
      data: {
        accountId: account.id,
        agentId: p.agentId,
        currency: p.currency,
        direction: LedgerDirection.DEBIT,
        amountMinor: p.amountMinor,
        type: LedgerEntryType.HOLD,
        balanceAfterMinor: available,
        relatedIntentId: p.intentId,
        idempotencyKey: `hold:${p.intentId}`,
      },
    });
    await this.audit(tx, p.agentId, 'WALLET_HOLD', {
      intentId: p.intentId,
      amountMinor: p.amountMinor.toString(),
      currency: p.currency,
      availableAfterMinor: available.toString(),
    });
  }

  /** Commit a hold once the payment settles: reserved -> out (funds leave). */
  async commitHoldTx(tx: Prisma.TransactionClient, p: MerchantHoldInput): Promise<void> {
    const account = await this.lockAccountTx(tx, p.agentId, p.currency);
    if (account.reservedMinor < p.amountMinor) {
      throw new Error('INSUFFICIENT_RESERVED');
    }
    const reserved = account.reservedMinor - p.amountMinor;
    await tx.agentAccount.update({
      where: { id: account.id },
      data: { reservedMinor: reserved }, // available already reduced at hold
    });
    await tx.ledgerEntry.create({
      data: {
        accountId: account.id,
        agentId: p.agentId,
        currency: p.currency,
        direction: LedgerDirection.DEBIT,
        amountMinor: p.amountMinor,
        type: LedgerEntryType.SPEND,
        balanceAfterMinor: account.availableMinor,
        relatedIntentId: p.intentId,
        idempotencyKey: `commit:${p.intentId}`,
      },
    });
    await this.audit(tx, p.agentId, 'WALLET_SPEND', {
      intentId: p.intentId,
      amountMinor: p.amountMinor.toString(),
      currency: p.currency,
      reservedAfterMinor: reserved.toString(),
    });
  }

  /** Release a hold when the payment does not settle: reserved -> available. */
  async releaseHoldTx(tx: Prisma.TransactionClient, p: MerchantHoldInput): Promise<void> {
    const account = await this.lockAccountTx(tx, p.agentId, p.currency);
    if (account.reservedMinor < p.amountMinor) {
      throw new Error('INSUFFICIENT_RESERVED');
    }
    const reserved = account.reservedMinor - p.amountMinor;
    const available = account.availableMinor + p.amountMinor;
    await tx.agentAccount.update({
      where: { id: account.id },
      data: { availableMinor: available, reservedMinor: reserved },
    });
    await tx.ledgerEntry.create({
      data: {
        accountId: account.id,
        agentId: p.agentId,
        currency: p.currency,
        direction: LedgerDirection.CREDIT,
        amountMinor: p.amountMinor,
        type: LedgerEntryType.RELEASE,
        balanceAfterMinor: available,
        relatedIntentId: p.intentId,
        idempotencyKey: `release:${p.intentId}`,
      },
    });
    await this.audit(tx, p.agentId, 'WALLET_RELEASE', {
      intentId: p.intentId,
      amountMinor: p.amountMinor.toString(),
      currency: p.currency,
      availableAfterMinor: available.toString(),
    });
  }

  /**
   * Credit an account INSIDE the caller's transaction (e.g. the Score Pool leg
   * of a forfeited score bond, which must land atomically with the agent's
   * hold commit). The account must already exist (ensureAccount first).
   */
  async creditTx(
    tx: Prisma.TransactionClient,
    p: { agentId: string; currency: string; amountMinor: bigint; type: LedgerEntryType; idempotencyKey: string; relatedIntentId?: string }
  ): Promise<bigint> {
    const account = await this.lockAccountTx(tx, p.agentId, p.currency);
    const available = account.availableMinor + p.amountMinor;
    await tx.agentAccount.update({ where: { id: account.id }, data: { availableMinor: available } });
    await tx.ledgerEntry.create({
      data: {
        accountId: account.id,
        agentId: p.agentId,
        currency: p.currency,
        direction: LedgerDirection.CREDIT,
        amountMinor: p.amountMinor,
        type: p.type,
        balanceAfterMinor: available,
        relatedIntentId: p.relatedIntentId,
        idempotencyKey: p.idempotencyKey,
      },
    });
    return available;
  }

  // -------------------------------------------------------------------------
  // RECEIVE — credit an agent's balance.
  // -------------------------------------------------------------------------
  async receive(input: ReceiveInput): Promise<WalletMovementResult> {
    const amount = this.assertMovement(input.amountMinor, input.currency, input.idempotencyKey);
    const type: ReceiveType = input.type ?? 'EXTERNAL_TOPUP';

    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      this.assertReplayMatches(existing, {
        agentId: input.agentId,
        currency: input.currency,
        amountMinor: amount,
        direction: LedgerDirection.CREDIT,
      });
      return this.toResult(existing, true);
    }

    const accountId = await this.ensureAccount(input.agentId, input.currency);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertAgentActive(tx, input.agentId);
        const balance = await this.lockBalance(tx, accountId);
        const newBalance = balance + amount;

        await tx.agentAccount.update({
          where: { id: accountId },
          data: { availableMinor: newBalance },
        });

        const entry = await tx.ledgerEntry.create({
          data: {
            accountId,
            agentId: input.agentId,
            currency: input.currency,
            direction: LedgerDirection.CREDIT,
            amountMinor: amount,
            type,
            balanceAfterMinor: newBalance,
            relatedIntentId: input.relatedIntentId,
            idempotencyKey: input.idempotencyKey,
          },
        });

        await this.audit(tx, input.agentId, 'WALLET_RECEIVE', {
          entryId: entry.id,
          type,
          amountMinor: amount.toString(),
          currency: input.currency,
          balanceAfterMinor: newBalance.toString(),
        });

        return this.toResult(entry, false);
      });
    } catch (error) {
      return this.recoverIdempotent(error, input.idempotencyKey, {
        agentId: input.agentId,
        currency: input.currency,
        amountMinor: amount,
        direction: LedgerDirection.CREDIT,
      });
    }
  }

  // -------------------------------------------------------------------------
  // SPEND — debit an agent's balance for an external payment.
  // -------------------------------------------------------------------------
  async spend(input: SpendInput): Promise<WalletMovementResult> {
    const amount = this.assertMovement(input.amountMinor, input.currency, input.idempotencyKey);

    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      this.assertReplayMatches(existing, {
        agentId: input.agentId,
        currency: input.currency,
        amountMinor: amount,
        direction: LedgerDirection.DEBIT,
      });
      return this.toResult(existing, true);
    }

    const accountId = await this.ensureAccount(input.agentId, input.currency);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertAgentActive(tx, input.agentId);
        const balance = await this.lockBalance(tx, accountId);
        if (balance < amount) {
          throw new Error('INSUFFICIENT_FUNDS');
        }
        const newBalance = balance - amount;

        await tx.agentAccount.update({
          where: { id: accountId },
          data: { availableMinor: newBalance },
        });

        const entry = await tx.ledgerEntry.create({
          data: {
            accountId,
            agentId: input.agentId,
            currency: input.currency,
            direction: LedgerDirection.DEBIT,
            amountMinor: amount,
            type: LedgerEntryType.SPEND,
            balanceAfterMinor: newBalance,
            relatedIntentId: input.relatedIntentId,
            idempotencyKey: input.idempotencyKey,
          },
        });

        await this.audit(tx, input.agentId, 'WALLET_SPEND', {
          entryId: entry.id,
          amountMinor: amount.toString(),
          currency: input.currency,
          relatedIntentId: input.relatedIntentId ?? null,
          balanceAfterMinor: newBalance.toString(),
        });

        return this.toResult(entry, false);
      });
    } catch (error) {
      return this.recoverIdempotent(error, input.idempotencyKey, {
        agentId: input.agentId,
        currency: input.currency,
        amountMinor: amount,
        direction: LedgerDirection.DEBIT,
      });
    }
  }

  // -------------------------------------------------------------------------
  // SEND — atomic agent-to-agent transfer (debit sender, credit recipient).
  // -------------------------------------------------------------------------
  async send(input: SendInput): Promise<SendResult> {
    const amount = this.assertMovement(input.amountMinor, input.currency, input.idempotencyKey);
    if (input.fromAgentId === input.toAgentId) {
      throw new Error('SELF_TRANSFER_NOT_ALLOWED');
    }

    const existing = await this.prisma.agentTransfer.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      return this.replayTransfer(existing, input, amount);
    }

    const fromAccountId = await this.ensureAccount(input.fromAgentId, input.currency);
    const toAccountId = await this.ensureAccount(input.toAgentId, input.currency);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertAgentActive(tx, input.fromAgentId);
        await this.assertAgentActive(tx, input.toAgentId);

        // Lock both accounts in a deterministic order to avoid deadlock.
        const [firstId, secondId] = [fromAccountId, toAccountId].sort();
        await this.lockBalance(tx, firstId);
        await this.lockBalance(tx, secondId);

        // A concurrent send with the same key may have committed while we waited
        // for the locks: replay it instead of failing on the now-lower balance.
        const committed = await tx.agentTransfer.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        if (committed) throw Object.assign(new Error('IDEMPOTENT_REPLAY'), { committed });

        const fromBalance = await this.readBalance(tx, fromAccountId);
        const toBalance = await this.readBalance(tx, toAccountId);
        if (fromBalance < amount) {
          throw new Error('INSUFFICIENT_FUNDS');
        }

        const fromAfter = fromBalance - amount;
        const toAfter = toBalance + amount;

        await tx.agentAccount.update({
          where: { id: fromAccountId },
          data: { availableMinor: fromAfter },
        });
        await tx.agentAccount.update({
          where: { id: toAccountId },
          data: { availableMinor: toAfter },
        });

        const transfer = await tx.agentTransfer.create({
          data: {
            idempotencyKey: input.idempotencyKey,
            fromAgentId: input.fromAgentId,
            toAgentId: input.toAgentId,
            amountMinor: amount,
            currency: input.currency,
          },
        });

        await tx.ledgerEntry.create({
          data: {
            accountId: fromAccountId,
            agentId: input.fromAgentId,
            currency: input.currency,
            direction: LedgerDirection.DEBIT,
            amountMinor: amount,
            type: LedgerEntryType.TRANSFER_OUT,
            balanceAfterMinor: fromAfter,
            counterpartyAgentId: input.toAgentId,
            transferId: transfer.id,
          },
        });
        await tx.ledgerEntry.create({
          data: {
            accountId: toAccountId,
            agentId: input.toAgentId,
            currency: input.currency,
            direction: LedgerDirection.CREDIT,
            amountMinor: amount,
            type: LedgerEntryType.TRANSFER_IN,
            balanceAfterMinor: toAfter,
            counterpartyAgentId: input.fromAgentId,
            transferId: transfer.id,
          },
        });

        await this.audit(tx, input.fromAgentId, 'WALLET_SEND', {
          transferId: transfer.id,
          toAgentId: input.toAgentId,
          amountMinor: amount.toString(),
          currency: input.currency,
          balanceAfterMinor: fromAfter.toString(),
        });

        return {
          transferId: transfer.id,
          fromBalanceAfterMinor: fromAfter,
          toBalanceAfterMinor: toAfter,
          amountMinor: amount,
          currency: input.currency,
          replayed: false,
        };
      });
    } catch (error) {
      const committed = (error as { committed?: Parameters<AgentWalletService['replayTransfer']>[0] }).committed;
      if (committed) return this.replayTransfer(committed, input, amount);
      if (this.isUniqueConstraintError(error)) {
        const raced = await this.prisma.agentTransfer.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (raced) {
          return this.replayTransfer(raced, input, amount);
        }
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private assertCurrency(currency: string): void {
    if (!CURRENCY_PATTERN.test(currency ?? '')) {
      throw new Error('INVALID_CURRENCY');
    }
  }

  private assertMovement(amount: bigint, currency: string, idempotencyKey: string): bigint {
    this.assertCurrency(currency);
    if (typeof amount !== 'bigint' || amount <= 0n) {
      throw new Error('INVALID_AMOUNT');
    }
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      throw new Error('IDEMPOTENCY_KEY_REQUIRED');
    }
    return amount;
  }

  private async assertAgentActive(
    tx: Prisma.TransactionClient,
    agentId: string
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ isActive: boolean }>>`
      SELECT "isActive" FROM "Agent" WHERE id = ${agentId} FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new Error('AGENT_NOT_FOUND');
    }
    if (!rows[0].isActive) {
      throw new Error('AGENT_INACTIVE');
    }
  }

  /** Locks the account row and returns its current balance. */
  private async lockBalance(
    tx: Prisma.TransactionClient,
    accountId: string
  ): Promise<bigint> {
    const rows = await tx.$queryRaw<Array<{ availableMinor: bigint }>>`
      SELECT "availableMinor" FROM "AgentAccount" WHERE id = ${accountId} FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new Error('ACCOUNT_NOT_FOUND');
    }
    return rows[0].availableMinor;
  }

  /** Locks an agent's account by (agentId, currency) and returns its full row. */
  private async lockAccountTx(
    tx: Prisma.TransactionClient,
    agentId: string,
    currency: string
  ): Promise<{ id: string; availableMinor: bigint; reservedMinor: bigint }> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; availableMinor: bigint; reservedMinor: bigint }>
    >`
      SELECT id, "availableMinor", "reservedMinor"
      FROM "AgentAccount"
      WHERE "agentId" = ${agentId} AND currency = ${currency}
      FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new Error('ACCOUNT_NOT_FOUND');
    }
    return rows[0];
  }

  private async readBalance(
    tx: Prisma.TransactionClient,
    accountId: string
  ): Promise<bigint> {
    const account = await tx.agentAccount.findUnique({ where: { id: accountId } });
    if (!account) {
      throw new Error('ACCOUNT_NOT_FOUND');
    }
    return account.availableMinor;
  }

  /**
   * Resolve (creating if absent) an agent's account for a currency. Kept outside
   * the movement transaction because a unique-violation on a concurrent create
   * would otherwise abort it in Postgres.
   */
  async ensureAccount(agentId: string, currency: string): Promise<string> {
    const found = await this.prisma.agentAccount.findUnique({
      where: { agentId_currency: { agentId, currency } },
    });
    if (found) {
      return found.id;
    }
    try {
      const created = await this.prisma.agentAccount.create({
        data: { agentId, currency, availableMinor: 0n },
      });
      return created.id;
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        const raced = await this.prisma.agentAccount.findUnique({
          where: { agentId_currency: { agentId, currency } },
        });
        if (raced) {
          return raced.id;
        }
      }
      throw error;
    }
  }

  private findByIdempotencyKey(idempotencyKey: string) {
    return this.prisma.ledgerEntry.findUnique({ where: { idempotencyKey } });
  }

  private assertReplayMatches(
    entry: {
      agentId: string;
      currency: string;
      amountMinor: bigint;
      direction: LedgerDirection;
    },
    expected: {
      agentId: string;
      currency: string;
      amountMinor: bigint;
      direction: LedgerDirection;
    }
  ): void {
    if (
      entry.agentId !== expected.agentId ||
      entry.currency !== expected.currency ||
      entry.amountMinor !== expected.amountMinor ||
      entry.direction !== expected.direction
    ) {
      throw new Error('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
    }
  }

  private async recoverIdempotent(
    error: unknown,
    idempotencyKey: string,
    expected: {
      agentId: string;
      currency: string;
      amountMinor: bigint;
      direction: LedgerDirection;
    }
  ): Promise<WalletMovementResult> {
    if (!this.isUniqueConstraintError(error)) {
      throw error;
    }
    const existing = await this.findByIdempotencyKey(idempotencyKey);
    if (!existing) {
      throw error;
    }
    this.assertReplayMatches(existing, expected);
    return this.toResult(existing, true);
  }

  private replayTransfer(
    existing: {
      id: string;
      fromAgentId: string;
      toAgentId: string;
      amountMinor: bigint;
      currency: string;
    },
    input: SendInput,
    amount: bigint
  ): Promise<SendResult> | SendResult {
    if (
      existing.fromAgentId !== input.fromAgentId ||
      existing.toAgentId !== input.toAgentId ||
      existing.amountMinor !== amount ||
      existing.currency !== input.currency
    ) {
      throw new Error('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
    }
    return (async () => {
      const [from, to] = await Promise.all([
        this.getBalance(input.fromAgentId, input.currency),
        this.getBalance(input.toAgentId, input.currency),
      ]);
      return {
        transferId: existing.id,
        fromBalanceAfterMinor: from,
        toBalanceAfterMinor: to,
        amountMinor: amount,
        currency: input.currency,
        replayed: true,
      };
    })();
  }

  private audit(
    tx: Prisma.TransactionClient,
    agentId: string,
    action: string,
    payload: Record<string, unknown>
  ) {
    return tx.auditLog.create({
      data: {
        traceId: agentId,
        actorId: agentId,
        actorType: 'AGENT',
        action,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }

  private toResult(
    entry: {
      id: string;
      agentId: string;
      direction: LedgerDirection;
      amountMinor: bigint;
      balanceAfterMinor: bigint;
      currency: string;
      type: LedgerEntryType;
    },
    replayed: boolean
  ): WalletMovementResult {
    return {
      entryId: entry.id,
      agentId: entry.agentId,
      direction: entry.direction,
      amountMinor: entry.amountMinor,
      balanceAfterMinor: entry.balanceAfterMinor,
      currency: entry.currency,
      type: entry.type,
      replayed,
    };
  }

  private isUniqueConstraintError(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return true;
    // Driver adapters (PGlite, pg) can surface the raw driver error instead of P2002.
    const e = error as { cause?: { kind?: string; originalCode?: string }; code?: string; message?: string } | null;
    return !!e && (e.cause?.kind === 'UniqueConstraintViolation' || e.cause?.originalCode === '23505' || e.code === '23505'
      || /duplicate key value violates unique constraint/.test(e.message ?? ''));
  }
}
