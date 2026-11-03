import { MerchantCharge, MerchantGrant, Prisma, PrismaClient } from '@prisma/client';
import { AgentWalletService } from '../services/AgentWalletService';
import { ScoreService, Settlement } from '../agentdev/ScoreService';
import { signEvent } from './signing';

// ---------------------------------------------------------------------------
// Merchant Connect — how an outside store (AgentBazaar) takes money from a
// PayPali agent and pays its vendors.
//
//   Owner  -> createGrant()    authorizes ONE merchant to draw up to maxMinor
//                              from ONE agent (revocable; revocation is pushed
//                              to the merchant as a `grant.revoked` webhook).
//   Merchant -> charge()       Score-gated `bazaar.purchase`: reserve on the
//                              grant -> commit a stake (points + bond) ->
//                              transfer agent -> merchant settlement account.
//   Merchant -> reportOutcome() settles that stake with the human-attested
//                              result of the purchase. Exactly once.
//   Merchant -> payout()       settlement account -> vendor agent.
//   Merchant -> refund()       settlement account -> agent for a purchase the
//                              vendor never delivered; restores the grant and
//                              settles the purchase stake as a failure.
//
// Fail-closed and crash-safe: a charge is created PENDING before any money or
// score moves; replaying the same idempotency key resumes it. Money only moves
// through AgentWalletService (row locks + append-only ledger).
// ---------------------------------------------------------------------------

export interface MerchantConfig {
  id: string;
  name?: string;
  secret: string;
  webhookUrl?: string;
}

export interface ChargeInput {
  grantId: string;
  amountMinor: bigint;
  currency: string;
  idempotencyKey: string;
  reference?: string;
  /** Score parameters supplied by the purchasing agent through the merchant. */
  score: { intentKey: string; confidencePct: number; ttlMs?: number };
}

export interface ChargeResult {
  chargeId?: string;
  status: 'PAID' | 'DECLINED' | 'REFUNDED';
  reasons: string[];
  amountMinor: bigint;
  currency: string;
  stakeId?: string | null;
  scoreQuote?: unknown;
  replayed: boolean;
}

export const PURCHASE_CAPABILITY = 'bazaar.purchase';
const DEFAULT_PURCHASE_TTL_MS = 7 * 86_400_000; // time for delivery + human attestation

export class MerchantService {
  private readonly merchants = new Map<string, MerchantConfig>();
  private readonly settlement = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly wallet: AgentWalletService,
    private readonly score: ScoreService,
    merchants: MerchantConfig[],
    private readonly now: () => Date = () => new Date()
  ) {
    for (const m of merchants) {
      if (!/^[a-z0-9-]{2,40}$/.test(m.id) || !m.secret || m.secret.length < 16) throw new Error(`INVALID_MERCHANT_CONFIG:${m.id}`);
      this.merchants.set(m.id, m);
    }
  }

  merchant(id: string | undefined): MerchantConfig | undefined {
    return id ? this.merchants.get(id) : undefined;
  }

  /** The merchant's own PayPali account (escrow for purchases, source of vendor payouts). */
  async settlementAgent(merchantId: string): Promise<string> {
    const cached = this.settlement.get(merchantId);
    if (cached) return cached;
    if (!this.merchants.has(merchantId)) throw new Error('UNKNOWN_MERCHANT');
    const email = `merchant+${merchantId}@paypali.system`;
    const owner = await this.prisma.owner.upsert({ where: { email }, update: {}, create: { email } });
    const name = `Merchant settlement: ${merchantId}`;
    const agent = (await this.prisma.agent.findFirst({ where: { ownerId: owner.id, name } }))
      ?? (await this.prisma.agent.create({ data: { ownerId: owner.id, name } }));
    this.settlement.set(merchantId, agent.id);
    return agent.id;
  }

  // -------------------------------------------------------------------------
  // Owner side
  // -------------------------------------------------------------------------
  async createGrant(ownerId: string, agentId: string, p: { merchantId: string; maxMinor: bigint; currency: string; expiresAt?: Date; principalPub?: string }) {
    if (!this.merchants.has(p.merchantId)) throw new Error('UNKNOWN_MERCHANT');
    if (typeof p.maxMinor !== 'bigint' || p.maxMinor <= 0n) throw new Error('INVALID_AMOUNT');
    if (!/^[A-Z]{3}$/.test(p.currency ?? '')) throw new Error('INVALID_CURRENCY');
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.ownerId !== ownerId) throw new Error('AGENT_NOT_OWNED');
    const g = await this.prisma.merchantGrant.create({
      data: { merchantId: p.merchantId, ownerId, agentId, currency: p.currency, maxMinor: p.maxMinor, expiresAt: p.expiresAt, principalPub: p.principalPub ?? null },
    });
    return grantView(g, this.now());
  }

  async revokeGrant(ownerId: string, grantId: string) {
    return this.prisma.$transaction(async (tx) => {
      const g = await tx.merchantGrant.findUnique({ where: { id: grantId } });
      if (!g || g.ownerId !== ownerId) throw new Error('GRANT_NOT_OWNED');
      if (g.status === 'REVOKED') return grantView(g, this.now());
      const upd = await tx.merchantGrant.update({ where: { id: grantId }, data: { status: 'REVOKED', revokedAt: this.now() } });
      await this.emit(tx, g.merchantId, 'grant.revoked', { grant_id: g.id, agent_id: g.agentId, revoked_at: upd.revokedAt });
      return grantView(upd, this.now());
    });
  }

  async listGrants(agentId: string) {
    const gs = await this.prisma.merchantGrant.findMany({ where: { agentId }, orderBy: { createdAt: 'desc' } });
    return gs.map((g) => grantView(g, this.now()));
  }

  /** Merchant view of one of ITS grants (another merchant's grant is NOT_FOUND). */
  async getGrant(merchantId: string, grantId: string) {
    const g = await this.prisma.merchantGrant.findUnique({ where: { id: grantId } });
    if (!g || g.merchantId !== merchantId) throw new Error('GRANT_NOT_FOUND');
    return grantView(g, this.now());
  }

  // -------------------------------------------------------------------------
  // Merchant side: CHARGE (Score-gated bazaar.purchase)
  // -------------------------------------------------------------------------
  async charge(merchantId: string, input: ChargeInput): Promise<ChargeResult> {
    const amount = input.amountMinor;
    if (typeof amount !== 'bigint' || amount <= 0n) throw new Error('INVALID_AMOUNT');
    if (!/^[A-Z]{3}$/.test(input.currency ?? '')) throw new Error('INVALID_CURRENCY');
    if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200) {
      throw new Error('IDEMPOTENCY_KEY_REQUIRED');
    }
    const declined = (reasons: string[], extra: Partial<ChargeResult> = {}): ChargeResult =>
      ({ status: 'DECLINED', reasons, amountMinor: amount, currency: input.currency, replayed: false, ...extra });

    let charge = await this.prisma.merchantCharge.findUnique({
      where: { merchantId_idempotencyKey: { merchantId, idempotencyKey: input.idempotencyKey } },
    });
    const isReplay = !!charge;
    if (charge) {
      if (charge.grantId !== input.grantId || charge.amountMinor !== amount || charge.currency !== input.currency) {
        throw new Error('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
      }
      if (charge.status !== 'PENDING') return chargeView(charge, true);
    } else {
      // 1. Reserve on the grant under a row lock (no money or score has moved yet).
      const reserved = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "MerchantGrant" WHERE id = ${input.grantId} FOR UPDATE`;
        const g = await tx.merchantGrant.findUnique({ where: { id: input.grantId } });
        const reasons = grantProblems(g, merchantId, amount, input.currency, this.now());
        if (reasons.length) return { reasons };
        await tx.merchantGrant.update({ where: { id: g!.id }, data: { usedMinor: { increment: amount } } });
        const c = await tx.merchantCharge.create({
          data: {
            merchantId, idempotencyKey: input.idempotencyKey, grantId: g!.id, agentId: g!.agentId, amountMinor: amount,
            currency: input.currency, reference: (input.reference ?? '').slice(0, 200), intentKey: String(input.score?.intentKey ?? ''),
          },
        });
        return { charge: c };
      }).catch((e) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { raced: true as const };
        throw e;
      });
      if ('raced' in reserved) return this.charge(merchantId, input); // concurrent same-key request won; replay it
      if ('reasons' in reserved) return declined(reserved.reasons!);
      charge = reserved.charge;
    }

    // 2. Score gate: commit (or adopt, after a crash) the bazaar.purchase stake.
    let stakeId = charge.stakeId;
    if (!stakeId) {
      const orphan = await this.prisma.scoreStake.findFirst({
        where: { agentId: charge.agentId, intentKey: charge.intentKey, capability: PURCHASE_CAPABILITY, status: 'OPEN' },
        orderBy: { createdAt: 'desc' },
      });
      if (orphan && orphan.createdAt >= charge.createdAt) {
        stakeId = orphan.id;
      } else {
        try {
          const committed = await this.score.commit({
            agentId: charge.agentId, capability: PURCHASE_CAPABILITY, intentKey: charge.intentKey,
            confidencePct: input.score?.confidencePct, amountMinor: amount, currency: charge.currency,
            ttlMs: input.score?.ttlMs ?? DEFAULT_PURCHASE_TTL_MS,
          });
          stakeId = committed.stakeId;
        } catch (e) {
          const q = (e as { quote?: { reasons: string[] } }).quote;
          const reasons = q ? q.reasons : [e instanceof Error ? e.message : 'SCORE_GATE_ERROR'];
          // A concurrent replay of this same charge is mid-commit: never decline
          // underneath it — tell the caller to retry the same key.
          if (isReplay && reasons.includes('ATTEMPT_IN_FLIGHT')) throw new Error('CHARGE_IN_PROGRESS');
          const done = await this.finishDeclined(charge, reasons.join(','));
          return { ...chargeView(done, false), reasons, scoreQuote: q };
        }
      }
      charge = await this.prisma.merchantCharge.update({ where: { id: charge.id }, data: { stakeId } });
    }

    // 3. Move the money: agent -> merchant settlement (idempotent on the charge id).
    const settlementId = await this.settlementAgent(merchantId);
    try {
      const t = await this.wallet.send({
        fromAgentId: charge.agentId, toAgentId: settlementId, amountMinor: amount, currency: charge.currency,
        idempotencyKey: `mc:${charge.id}`,
      });
      const paid = await this.prisma.merchantCharge.update({ where: { id: charge.id }, data: { status: 'PAID', transferId: t.transferId } });
      return chargeView(paid, false);
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'TRANSFER_FAILED';
      const done = await this.finishDeclined(charge, reason);
      // The agent staked on a purchase it could not pay for: that is a failed action.
      await this.score.settle(stakeId!, { success: false, evidence: { reason, chargeId: charge.id } });
      return chargeView(done, false);
    }
  }

  /** Settle the purchase stake with the human-attested outcome (exactly once). */
  async reportOutcome(merchantId: string, chargeId: string, o: { success: boolean; evidence?: Record<string, unknown> }): Promise<Settlement> {
    const c = await this.prisma.merchantCharge.findUnique({ where: { id: chargeId } });
    if (!c || c.merchantId !== merchantId) throw new Error('CHARGE_NOT_FOUND');
    if (c.status !== 'PAID' || !c.stakeId) throw new Error('CHARGE_NOT_SETTLEABLE');
    if (typeof o?.success !== 'boolean') throw new Error('OUTCOME_MUST_BE_BOOLEAN');
    return this.score.settle(c.stakeId, { success: o.success, evidence: { ...(o.evidence ?? {}), chargeId, merchantId, source: 'merchant_attested' } });
  }

  /**
   * Refund a PAID charge (non-delivery). Money: settlement -> agent, idempotent on
   * `mrefund:<chargeId>`. The PAID -> REFUNDED transition is a conditional update,
   * so concurrent calls give the grant its headroom back exactly once. The purchase
   * stake, if still open, settles as a failure: the purchase did not produce a result.
   */
  async refund(merchantId: string, chargeId: string, reason = 'non_delivery'): Promise<ChargeResult & { refundTransferId: string | null; stake?: Settlement | null }> {
    const c = await this.prisma.merchantCharge.findUnique({ where: { id: chargeId } });
    if (!c || c.merchantId !== merchantId) throw new Error('CHARGE_NOT_FOUND');
    if (c.status === 'REFUNDED') return { ...chargeView(c, true), refundTransferId: c.refundTransferId, stake: null };
    if (c.status !== 'PAID') throw new Error('CHARGE_NOT_REFUNDABLE');
    const why = String(reason || 'non_delivery').slice(0, 120);
    const t = await this.wallet.send({
      fromAgentId: await this.settlementAgent(merchantId), toAgentId: c.agentId, amountMinor: c.amountMinor, currency: c.currency,
      idempotencyKey: `mrefund:${c.id}`,
    });
    const done = await this.prisma.$transaction(async (tx) => {
      const flipped = await tx.merchantCharge.updateMany({
        where: { id: c.id, status: 'PAID' },
        data: { status: 'REFUNDED', refundedAt: this.now(), refundTransferId: t.transferId, reason: `refund:${why}` },
      });
      if (flipped.count === 1) {
        await tx.merchantGrant.update({ where: { id: c.grantId }, data: { usedMinor: { decrement: c.amountMinor } } });
        await this.emit(tx, merchantId, 'charge.refunded', { chargeId: c.id, grantId: c.grantId, amountMinor: c.amountMinor.toString(), currency: c.currency, reason: why });
      }
      return tx.merchantCharge.findUniqueOrThrow({ where: { id: c.id } });
    });
    let stake: Settlement | null = null;
    if (c.stakeId) stake = await this.score.settle(c.stakeId, { success: false, evidence: { chargeId: c.id, merchantId, reason: `refund:${why}`, source: 'merchant_refund' } });
    return { ...chargeView(done, false), refundTransferId: done.refundTransferId, stake };
  }

  // -------------------------------------------------------------------------
  // Merchant side: PAYOUT (settlement account -> vendor agent)
  // -------------------------------------------------------------------------
  /** Optional vendor-ownership check (KycService.verifyPayoutBinding): returns an error code or null. */
  payoutBindingCheck: ((binding: unknown, toAgentId: string) => Promise<string | null>) | null = null;
  /** When true, every payout must carry a binding that passes payoutBindingCheck. */
  requirePayoutBinding = false;

  async payout(merchantId: string, p: { toAgentId: string; amountMinor: bigint; currency: string; idempotencyKey: string; reference?: string; binding?: unknown }) {
    if (typeof p.amountMinor !== 'bigint' || p.amountMinor <= 0n) throw new Error('INVALID_AMOUNT');
    if (typeof p.idempotencyKey !== 'string' || !p.idempotencyKey.trim()) throw new Error('IDEMPOTENCY_KEY_REQUIRED');
    const existing = await this.prisma.merchantPayout.findUnique({
      where: { merchantId_idempotencyKey: { merchantId, idempotencyKey: p.idempotencyKey } },
    });
    if (existing) {
      if (existing.toAgentId !== p.toAgentId || existing.amountMinor !== p.amountMinor || existing.currency !== p.currency) {
        throw new Error('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
      }
      return { payoutId: existing.id, transferId: existing.transferId, amountMinor: existing.amountMinor, replayed: true };
    }
    const to = await this.prisma.agent.findUnique({ where: { id: p.toAgentId } });
    if (!to) throw new Error('RECIPIENT_NOT_FOUND');
    if (this.requirePayoutBinding || (p.binding && this.payoutBindingCheck)) {
      if (!this.payoutBindingCheck) throw new Error('PAYOUT_BINDING_CHECK_NOT_CONFIGURED');
      const problem = await this.payoutBindingCheck(p.binding ?? null, p.toAgentId);
      if (problem) throw new Error(problem);
    }
    const from = await this.settlementAgent(merchantId);
    const t = await this.wallet.send({
      fromAgentId: from, toAgentId: p.toAgentId, amountMinor: p.amountMinor, currency: p.currency,
      idempotencyKey: `mp:${merchantId}:${p.idempotencyKey}`,
    });
    const rec = await this.prisma.merchantPayout.upsert({
      where: { merchantId_idempotencyKey: { merchantId, idempotencyKey: p.idempotencyKey } },
      update: {},
      create: { merchantId, idempotencyKey: p.idempotencyKey, toAgentId: p.toAgentId, amountMinor: p.amountMinor,
        currency: p.currency, reference: (p.reference ?? '').slice(0, 200), transferId: t.transferId },
    });
    return { payoutId: rec.id, transferId: rec.transferId, amountMinor: rec.amountMinor, replayed: false };
  }

  async balance(merchantId: string, currency: string) {
    return { merchantId, currency, availableMinor: await this.wallet.getBalance(await this.settlementAgent(merchantId), currency) };
  }

  // -------------------------------------------------------------------------
  // Outbound webhooks (PayPali -> merchant)
  // -------------------------------------------------------------------------
  async deliverDue(fetchImpl: typeof fetch = fetch, limit = 20): Promise<{ delivered: number; failed: number }> {
    const due = await this.prisma.merchantEvent.findMany({
      where: { status: 'PENDING', availableAt: { lte: this.now() } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    let delivered = 0, failed = 0;
    for (const ev of due) {
      const m = this.merchants.get(ev.merchantId);
      if (!m?.webhookUrl) {
        await this.prisma.merchantEvent.update({ where: { id: ev.id }, data: { status: 'FAILED', lastError: 'NO_WEBHOOK_URL' } });
        failed++;
        continue;
      }
      const body = JSON.stringify({ id: ev.id, type: ev.type, created_at: ev.createdAt, data: ev.payload });
      const ts = Date.now();
      let err: string | null = null;
      try {
        const res = await fetchImpl(m.webhookUrl, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/json', 'x-paypali-event-id': ev.id, 'x-paypali-signature': signEvent(m.secret, ts, ev.id, body) },
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (res.status < 200 || res.status >= 300) err = `HTTP_${res.status}`;
      } catch (e) {
        err = e instanceof Error ? e.message : 'NETWORK_ERROR';
      }
      if (!err) {
        await this.prisma.merchantEvent.update({ where: { id: ev.id }, data: { status: 'DELIVERED', deliveredAt: this.now(), attempts: { increment: 1 } } });
        delivered++;
      } else {
        const attempts = ev.attempts + 1;
        await this.prisma.merchantEvent.update({
          where: { id: ev.id },
          data: {
            attempts, lastError: err.slice(0, 300),
            status: attempts >= 10 ? 'FAILED' : 'PENDING',
            availableAt: new Date(this.now().getTime() + Math.min(3_600_000, 1000 * 2 ** attempts)),
          },
        });
        failed++;
      }
    }
    return { delivered, failed };
  }

  private emit(tx: Prisma.TransactionClient, merchantId: string, type: string, payload: Record<string, unknown>) {
    return tx.merchantEvent.create({ data: { merchantId, type, payload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue } });
  }

  /** Mark a charge DECLINED and give the reserved amount back to the grant. */
  private finishDeclined(charge: MerchantCharge, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.merchantGrant.update({ where: { id: charge.grantId }, data: { usedMinor: { decrement: charge.amountMinor } } });
      return tx.merchantCharge.update({ where: { id: charge.id }, data: { status: 'DECLINED', reason: reason.slice(0, 300) } });
    });
  }
}

function grantProblems(g: MerchantGrant | null, merchantId: string, amount: bigint, currency: string, now: Date): string[] {
  if (!g || g.merchantId !== merchantId) return ['GRANT_NOT_FOUND'];
  const r: string[] = [];
  if (g.status !== 'ACTIVE') r.push('GRANT_REVOKED');
  if (g.expiresAt && g.expiresAt <= now) r.push('GRANT_EXPIRED');
  if (g.currency !== currency) r.push('GRANT_CURRENCY_MISMATCH');
  if (g.usedMinor + amount > g.maxMinor) r.push('GRANT_LIMIT_EXCEEDED');
  return r;
}

function grantView(g: MerchantGrant, now: Date) {
  const live = g.status === 'ACTIVE' && (!g.expiresAt || g.expiresAt > now);
  return {
    grantId: g.id, merchantId: g.merchantId, agentId: g.agentId, currency: g.currency, status: live ? 'ACTIVE' : g.status === 'REVOKED' ? 'REVOKED' : 'EXPIRED',
    maxMinor: g.maxMinor, usedMinor: g.usedMinor, remainingMinor: g.maxMinor - g.usedMinor, expiresAt: g.expiresAt,
    principalPub: g.principalPub ?? null,
  };
}

function chargeView(c: MerchantCharge, replayed: boolean): ChargeResult {
  return {
    chargeId: c.id, status: c.status === 'PAID' ? 'PAID' : c.status === 'REFUNDED' ? 'REFUNDED' : 'DECLINED', reasons: c.reason ? c.reason.split(',') : [],
    amountMinor: c.amountMinor, currency: c.currency, stakeId: c.stakeId, replayed,
  };
}
