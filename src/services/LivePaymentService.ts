import { PrismaClient } from '@prisma/client';
import { AgentWalletService } from './AgentWalletService';
import { IPayPalCommerceGateway } from '../providers/paypal/IPayPalCommerceGateway';
import { IBrowserCheckoutDriver } from '../providers/checkout/IBrowserCheckoutDriver';

// ---------------------------------------------------------------------------
// Live agent transactions: the layer that actually moves money on PayPal for an
// agent's spend / send / receive, keeping the internal ledger in step.
//
//   pay         -> pay a merchant/payee via a PayPal Order (authorized recipient)
//   checkoutOnSite -> pay on a site that offers PayPal but gave no Order (browser)
//   payoutExternal -> send to another PayPal receiver via Payouts
//   receiveInbound -> capture an authorized inbound PayPal Order (top-up)
//
// Discipline:
//  * Fail-closed first: a missing/inactive agent, a bad request, or an
//    insufficient balance is rejected BEFORE any external call — money never
//    leaves for an unauthorized or unfunded agent.
//  * External-then-internal: the authoritative PayPal movement runs first; the
//    internal ledger is updated only on an observed PAID, under the SAME
//    idempotency key, so a replay neither double-pays nor double-debits.
//  * Honest outcomes: DECLINED / UNSUPPORTED / AMBIGUOUS pass straight through
//    with no ledger change. If PayPal paid but the internal debit cannot be
//    applied, the result is REQUIRES_RECONCILIATION (never a silent success).
//
// Note: this is the agent-skill execution path. The heavy, crash-safe merchant
// flow (reserve -> outbox -> settle) still lives in LedgerService/PaymentOutboxWorker;
// this service deliberately keeps a smaller surface for direct agent calls.
// ---------------------------------------------------------------------------

export type LiveStatus =
  | 'PAID'
  | 'DECLINED'
  | 'UNSUPPORTED'
  | 'AMBIGUOUS'
  | 'REQUIRES_RECONCILIATION';

export interface LiveResult {
  status: LiveStatus;
  idempotencyKey: string;
  reason?: string;
  providerRef?: string;
  amountMinor?: bigint;
  currency?: string;
  balanceAfterMinor?: bigint;
}

export interface PayInput {
  agentId: string;
  payeeReference: string;
  amountMinor: bigint;
  currency: string;
  description: string;
  idempotencyKey: string;
  merchantCategoryCode?: string;
}

export interface CheckoutInput {
  agentId: string;
  siteUrl: string;
  amountMinor: bigint;
  currency: string;
  idempotencyKey: string;
  instructions?: string;
}

export interface PayoutInput {
  agentId: string;
  receiver: string;
  amountMinor: bigint;
  currency: string;
  note: string;
  idempotencyKey: string;
}

export interface ReceiveInboundInput {
  agentId: string;
  orderId: string;
  amountMinor: bigint;
  currency: string;
  idempotencyKey: string;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class LivePaymentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly wallet: AgentWalletService,
    private readonly commerce: IPayPalCommerceGateway,
    private readonly checkout: IBrowserCheckoutDriver
  ) {}

  /** Pay a merchant/payee for an authorized purchase (PayPal Order). */
  async pay(input: PayInput): Promise<LiveResult> {
    return this.executeDebit(
      input.agentId,
      input.amountMinor,
      input.currency,
      input.idempotencyKey,
      () =>
        this.commerce.spend({
          payeeReference: input.payeeReference,
          amountMinor: input.amountMinor,
          currency: input.currency,
          description: input.description,
          idempotencyKey: input.idempotencyKey,
          merchantCategoryCode: input.merchantCategoryCode,
        })
    );
  }

  /** Pay on a site that offers PayPal but handed no Order (browser-driven). */
  async checkoutOnSite(input: CheckoutInput): Promise<LiveResult> {
    return this.executeDebit(
      input.agentId,
      input.amountMinor,
      input.currency,
      input.idempotencyKey,
      () =>
        this.checkout.checkout({
          siteUrl: input.siteUrl,
          amountMinor: input.amountMinor,
          currency: input.currency,
          idempotencyKey: input.idempotencyKey,
          instructions: input.instructions,
        })
    );
  }

  /** Send funds to another PayPal receiver (external, not an internal agent). */
  async payoutExternal(input: PayoutInput): Promise<LiveResult> {
    return this.executeDebit(
      input.agentId,
      input.amountMinor,
      input.currency,
      input.idempotencyKey,
      () =>
        this.commerce.payout({
          receiver: input.receiver,
          amountMinor: input.amountMinor,
          currency: input.currency,
          note: input.note,
          idempotencyKey: input.idempotencyKey,
        })
    );
  }

  /** Capture an authorized inbound PayPal Order and credit the agent wallet. */
  async receiveInbound(input: ReceiveInboundInput): Promise<LiveResult> {
    const guard = await this.validate(input.agentId, input.amountMinor, input.currency, input.idempotencyKey);
    if (guard) return guard;

    const outcome = await this.commerce.captureInbound({
      orderId: input.orderId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      idempotencyKey: input.idempotencyKey,
    });
    if (outcome.status !== 'PAID') {
      return { status: outcome.status, reason: outcome.reason, idempotencyKey: input.idempotencyKey };
    }
    try {
      const credit = await this.wallet.receive({
        agentId: input.agentId,
        amountMinor: outcome.amountMinor,
        currency: outcome.currency,
        idempotencyKey: input.idempotencyKey,
        type: 'EXTERNAL_TOPUP',
      });
      return {
        status: 'PAID',
        idempotencyKey: input.idempotencyKey,
        providerRef: outcome.providerRef,
        amountMinor: outcome.amountMinor,
        currency: outcome.currency,
        balanceAfterMinor: credit.balanceAfterMinor,
      };
    } catch (err) {
      // PayPal captured the inbound but we could not credit the wallet: record
      // for reconciliation rather than losing the capture.
      return {
        status: 'REQUIRES_RECONCILIATION',
        idempotencyKey: input.idempotencyKey,
        providerRef: outcome.providerRef,
        reason: `CREDIT_FAILED:${err instanceof Error ? err.message : 'UNKNOWN'}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Shared debit path: validate -> external pay -> internal debit on PAID.
  // -------------------------------------------------------------------------
  private async executeDebit(
    agentId: string,
    amountMinor: bigint,
    currency: string,
    idempotencyKey: string,
    externalCall: () => Promise<import('../providers/paypal/IPayPalCommerceGateway').CommerceResult>
  ): Promise<LiveResult> {
    const guard = await this.validate(agentId, amountMinor, currency, idempotencyKey, /* requireFunds */ true);
    if (guard) return guard;

    const outcome = await externalCall();
    if (outcome.status !== 'PAID') {
      return { status: outcome.status, reason: outcome.reason, idempotencyKey };
    }

    try {
      const debit = await this.wallet.spend({
        agentId,
        amountMinor: outcome.amountMinor,
        currency: outcome.currency,
        idempotencyKey,
      });
      return {
        status: 'PAID',
        idempotencyKey,
        providerRef: outcome.providerRef,
        amountMinor: outcome.amountMinor,
        currency: outcome.currency,
        balanceAfterMinor: debit.balanceAfterMinor,
      };
    } catch (err) {
      // External payment succeeded but the internal debit failed (e.g. a race
      // drained the balance): never report success — flag for reconciliation.
      return {
        status: 'REQUIRES_RECONCILIATION',
        idempotencyKey,
        providerRef: outcome.providerRef,
        reason: `DEBIT_FAILED:${err instanceof Error ? err.message : 'UNKNOWN'}`,
      };
    }
  }

  /** Fail-closed pre-flight. Returns a terminal LiveResult, or null if OK. */
  private async validate(
    agentId: string,
    amountMinor: bigint,
    currency: string,
    idempotencyKey: string,
    requireFunds = false
  ): Promise<LiveResult | null> {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
      return { status: 'DECLINED', reason: 'MISSING_IDEMPOTENCY_KEY', idempotencyKey: idempotencyKey ?? '' };
    }
    if (typeof amountMinor !== 'bigint' || amountMinor <= 0n) {
      return { status: 'DECLINED', reason: 'INVALID_AMOUNT', idempotencyKey };
    }
    if (!CURRENCY_PATTERN.test(currency ?? '')) {
      return { status: 'DECLINED', reason: 'INVALID_CURRENCY', idempotencyKey };
    }
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      return { status: 'DECLINED', reason: 'AGENT_NOT_FOUND', idempotencyKey };
    }
    if (!agent.isActive) {
      return { status: 'DECLINED', reason: 'AGENT_INACTIVE', idempotencyKey };
    }
    // Fail closed BEFORE any external call: never pay out for an unfunded agent.
    if (requireFunds) {
      const available = await this.wallet.getBalance(agentId, currency);
      if (available < amountMinor) {
        return { status: 'DECLINED', reason: 'INSUFFICIENT_FUNDS', idempotencyKey };
      }
    }
    return null;
  }
}
