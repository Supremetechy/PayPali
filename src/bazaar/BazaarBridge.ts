import { createHash, randomBytes } from 'node:crypto';
import { AgentConnection, BazaarAccount, BazaarOrder, Prisma, PrismaClient, RiskClass } from '@prisma/client';
import { AgentDevService } from '../agentdev/AgentDevService';
import { MerchantService } from '../merchant/MerchantService';
import { GasService } from '../market/GasService';
import { BazaarClient } from './BazaarClient';
import { KycService } from './KycService';
import { BazaarKey, canon, verifyMarketDoc } from './keys';
import { PurchasePolicyService } from './PurchasePolicyService';

// ---------------------------------------------------------------------------
// AgentBazaar bridge — every PayPali agent can shop the Bazaar.
//
//   enable()  owner act: open the agent's Score account, grant bazaar.purchase,
//             issue a PayPali merchant grant to the Bazaar, and sign a Bazaar
//             mandate funded by that grant with the owner's custodial principal key.
//   buy()     agent act: connection mandate (if any) under a row lock → Bazaar
//             quote → Bazaar purchase with the agent's stated confidence. The
//             Bazaar charges PayPali, which runs the Score-gated `bazaar.purchase`
//             stake. The signed receipt is verified against the market key.
//   run()/report()  agent acts on a receipt.
//   attest()  OWNER act only: the human verdict that settles the purchase stake.
//
// Agents connected over MCP get buy/run/report as tools; attestation never is one.
// ---------------------------------------------------------------------------

export const BAZAAR_SERVICE_ID = 'agentbazaar';
const MANDATE_MAX_DAYS = 30;
const RENEW_BEFORE_MS = 3_600_000;
const MAX_BUDGET = 100_000_000n;

export interface EnableOptions {
  budgetMinor?: bigint;
  capMinor?: bigint;
  minTier?: number;
  days?: number;
}

export type BuyStatus = 'PAID' | 'DECLINED' | 'APPROVAL_REQUIRED' | 'PENDING' | 'FAILED';

export interface BuyResult {
  status: BuyStatus;
  reasons: string[];
  orderId?: string;
  solution?: { id: string; name: string; tier: number; price: number };
  amountMinor?: bigint;
  gasEquivalent?: number;
  receiptId?: string;
  chargeId?: string | null;
  stakeId?: string | null;
  runsIncluded?: number;
  receiptVerified?: boolean;
  scoreQuote?: unknown;
}

const err = (code: string) => new Error(code);

export interface IdentityStatus { issuer: string; assurance: string; method?: string; countsAsEvidence: boolean; error?: string }

export class BazaarBridge {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly dev: AgentDevService,
    private readonly merchants: MerchantService,
    private readonly gas: GasService,
    readonly client: BazaarClient,
    readonly merchantId = 'agentbazaar',
    private readonly now: () => Date = () => new Date()
  ) {
    this.policy = new PurchasePolicyService(prisma);
  }

  /** Purchase policy: the use-case taxonomy and per-agent owner overrides. */
  readonly policy: PurchasePolicyService;

  /** Optional: PayPali vouches for each owner's principal (dev = one account, kyc = one verified person). */
  identity: KycService | null = null;

  /** Present a fresh PayPali identity credential for the owner's Bazaar principal. Never fatal. */
  async attachIdentity(ownerId: string): Promise<IdentityStatus | null> {
    if (!this.identity) return null;
    const principal = await this.principalKey(ownerId);
    await this.client.call(principal, 'POST', '/v1/principals', {});
    const cred = await this.identity.credentialFor(ownerId, principal.pub);
    const r = await this.client.call(principal, 'POST', '/v1/principals/me/identity', { credential: cred });
    const base = { issuer: cred.body.issuer, assurance: cred.body.assurance, method: cred.body.method };
    if (r.status !== 200) return { ...base, countsAsEvidence: false, error: r.body?.error ?? String(r.status) };
    return { ...base, countsAsEvidence: !!r.body?.identity?.counts_as_evidence };
  }

  // -------------------------------------------------------------------------
  // Owner: enable / disable / status
  // -------------------------------------------------------------------------
  async enable(ownerId: string, agentId: string, opts: EnableOptions = {}) {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.ownerId !== ownerId) throw err('AGENT_NOT_OWNED');
    if (!agent.isActive) throw err('AGENT_INACTIVE');
    const budget = opts.budgetMinor ?? 20_000n;
    const cap = opts.capMinor ?? (budget < 5_000n ? budget : 5_000n);
    const minTier = opts.minTier ?? 1;
    const days = opts.days ?? MANDATE_MAX_DAYS;
    if (!(budget > 0n && budget <= MAX_BUDGET)) throw err('INVALID_BUDGET');
    if (!(cap > 0n && cap <= budget)) throw err('INVALID_CAP');
    if (!(Number.isInteger(minTier) && minTier >= 1 && minTier <= 4)) throw err('INVALID_MIN_TIER');
    if (!(Number.isInteger(days) && days >= 1 && days <= MANDATE_MAX_DAYS)) throw err('INVALID_DAYS');

    const { payments } = await this.client.marketKey();
    if (payments !== 'paypali') throw err('BAZAAR_NOT_CONNECTED_TO_PAYPALI');

    await this.dev.score.open(agentId);
    await this.dev.skills.grantCapability(ownerId, agentId, 'bazaar.purchase', 'HIGH' as RiskClass);
    const principal = await this.principalKey(ownerId);
    const reg = await this.client.call(principal, 'POST', '/v1/principals', {});
    if (reg.status !== 200) throw err('BAZAAR_PRINCIPAL_REFUSED:' + (reg.body?.error ?? reg.status));
    const identity = await this.attachIdentity(ownerId).catch((e): IdentityStatus => ({ issuer: this.identity?.issuer.id ?? '', assurance: '', countsAsEvidence: false, error: String(e?.message ?? e) }));
    const { account, key } = await this.agentKey(ownerId, agentId);

    // Exp strictly inside the Bazaar's 30-day ceiling.
    const exp = this.now().getTime() + days * 86_400_000 - 60_000;
    const grant = await this.merchants.createGrant(ownerId, agentId, { merchantId: this.merchantId, maxMinor: budget, currency: 'USD', expiresAt: new Date(exp), principalPub: principal.pub });
    const body = {
      mid: 'm_' + randomBytes(10).toString('hex'), principal_pub: principal.pub, agent_pub: key.pub,
      budget: Number(budget) / 100, cap: Number(cap) / 100, min_tier: minTier, categories: ['*'], exp,
      funding: { provider: 'paypali', grant_id: grant.grantId },
    };
    const r = await this.client.call(principal, 'POST', '/v1/mandates', { mandate: { body, sig: principal.sign(canon(body)) } });
    if (r.status !== 200) {
      await this.merchants.revokeGrant(ownerId, grant.grantId).catch(() => undefined);
      throw err('BAZAAR_MANDATE_REFUSED:' + (r.body?.error ?? r.status));
    }
    // Earlier mandates are left in place so receipts bought under them stay usable;
    // the bridge only ever buys under the newest one.
    const updated = await this.prisma.bazaarAccount.update({
      where: { agentId },
      data: { grantId: grant.grantId, mandateId: body.mid, mandateExpiresAt: new Date(exp), budgetMinor: budget, capMinor: cap, minTier, disabledAt: null },
    });
    return { ...this.accountView(updated), identity };
  }

  /** Owner kill switch: revoke the current Bazaar mandate and the PayPali grant behind it. */
  async disable(ownerId: string, agentId: string) {
    const acct = await this.prisma.bazaarAccount.findUnique({ where: { agentId } });
    if (!acct || acct.ownerId !== ownerId) throw err('BAZAAR_NOT_ENABLED');
    if (acct.mandateId) await this.client.call(await this.principalKey(ownerId), 'POST', `/v1/mandates/${acct.mandateId}/revoke`, {});
    if (acct.grantId) await this.merchants.revokeGrant(ownerId, acct.grantId).catch(() => undefined);
    return this.accountView(await this.prisma.bazaarAccount.update({ where: { agentId }, data: { mandateId: null, mandateExpiresAt: null, grantId: null, disabledAt: this.now() } }));
  }

  async status(agentId: string) {
    const acct = await this.prisma.bazaarAccount.findUnique({ where: { agentId } });
    const orders = await this.prisma.bazaarOrder.findMany({ where: { agentId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return { account: acct ? this.accountView(acct) : null, orders: orders.map((o) => this.orderView(o)) };
  }

  // -------------------------------------------------------------------------
  // Agent: search / buy / run / report
  // -------------------------------------------------------------------------
  async search(q: { query?: string; category?: string; minTier?: number }) {
    const p = new URLSearchParams();
    if (q.query) p.set('q', q.query);
    if (q.category) p.set('category', q.category);
    if (q.minTier) p.set('min_tier', String(q.minTier));
    const r = await this.client.call(null, 'GET', '/v1/search' + (p.size ? '?' + p : ''));
    if (r.status !== 200) throw err('BAZAAR_SEARCH_FAILED');
    return {
      results: (r.body.results ?? []).map((s: any) => ({
        id: s.id, name: s.name, category: s.category, blurb: s.blurb, price: s.price, priceMinor: s.price_minor, gasEquivalent: this.gas.minorToGas(s.price_minor),
        runsIncluded: s.runs_included, vendor: s.vendor?.display_name ?? s.seller ?? null, function: s.function ?? null, fulfillment: s.fulfillment,
        tier: s.verification?.tier, claimedSuccess: s.claimed_success, observedRate: s.verification?.rate, attestedOutcomes: s.verification?.n,
        basis: s.verification?.basis ?? null, seedData: !!s.verification?.seed, vendorId: s.vendor?.id ?? null, vendorVerified: s.vendor ? !!s.vendor.identity_verified : null, sellerAgentId: s.vendor?.agent_id ?? null,
        outcomeMetric: s.outcome_metric ?? null,
      })),
    };
  }

  async buy(
    agentId: string,
    input: {
      solutionId: string;
      confidencePct: number;
      intentKey?: string;
      // Purchase-policy context (see src/bazaar/purchasePolicy). All optional; an absent
      // category is treated as uncategorized and needs owner confirmation.
      category?: string;
      trigger?: string;
      beneficiary?: string;
      budgetOwner?: string;
      onFailure?: string;
      recurring?: boolean;
      paidAccess?: boolean;
      personalData?: boolean;
      /** The owner has already confirmed this specific purchase (satisfies a CONFIRM category). */
      ownerApproved?: boolean;
    },
    connection?: AgentConnection | null,
  ): Promise<BuyResult> {
    const acct = await this.ready(agentId, connection);
    const sol = await this.client.call(null, 'GET', `/v1/solutions/${encodeURIComponent(input.solutionId)}`);
    if (sol.status !== 200) return { status: 'DECLINED', reasons: ['SOLUTION_NOT_FOUND'] };
    const s = sol.body;
    const solution = { id: s.id, name: s.name, tier: s.verification?.tier, price: s.price };
    const amountMinor = BigInt(s.price_minor);
    const base = { solution, amountMinor, gasEquivalent: this.gas.minorToGas(s.price_minor) };

    // Purchase policy: classify this purchase and decide whether a human must confirm.
    // The capture fields are recorded on the order whatever the outcome, so an owner
    // reviewing a CONFIRM purchase sees the item, vendor, total and terms.
    const decision = await this.policy.resolve(agentId, {
      category: input.category, amountMinor, recurring: input.recurring, paidAccess: input.paidAccess, personalData: input.personalData,
    });
    const capture = {
      category: decision.category === 'uncategorized' ? null : decision.category,
      permission: decision.permission,
      trigger: input.trigger ?? null,
      beneficiary: input.beneficiary ?? null,
      item: s.name ?? null,
      vendor: s.vendor?.display_name ?? s.seller ?? null,
      recurring: !!input.recurring,
      personalData: decision.reasons.includes('PERSONAL_DATA_REQUIRES_APPROVAL'),
      budgetOwner: input.budgetOwner ?? null,
      onFailure: input.onFailure ?? null,
    };

    // Prohibited: never charged, recorded as FAILED for the audit trail.
    if (decision.permission === 'PROHIBITED') {
      const rec = await this.prisma.bazaarOrder.create({
        data: { agentId, connectionId: connection?.id ?? null, solutionId: s.id, amountMinor, currency: 'USD', status: 'FAILED', reason: ['PURCHASE_PROHIBITED', ...decision.reasons].join(','), ...capture },
      });
      return { ...base, status: 'DECLINED', reasons: ['PURCHASE_PROHIBITED', ...decision.reasons], orderId: rec.id };
    }
    // Confirm: hold for the owner. Recorded with full context; no mandate reservation and no
    // charge until the owner approves (re-call buy with ownerApproved once they do).
    if (decision.permission === 'CONFIRM' && !input.ownerApproved) {
      const rec = await this.prisma.bazaarOrder.create({
        data: { agentId, connectionId: connection?.id ?? null, solutionId: s.id, amountMinor, currency: 'USD', status: 'PENDING', reason: ['APPROVAL_REQUIRED', ...decision.reasons].join(','), ...capture },
      });
      return { ...base, status: 'APPROVAL_REQUIRED', reasons: ['APPROVAL_REQUIRED', ...decision.reasons], orderId: rec.id };
    }

    // Connection mandate, Bazaar quote and purchase (shared with the owner-approval path).
    return this.reserveQuoteAndPurchase({ agentId, connection, acct, solution: s, amountMinor, base, capture, input });
  }

  /**
   * Shared tail of buy() and approve(): reserve against the connection mandate under a row
   * lock (so parallel buys cannot slip past the daily cap), quote the Bazaar, then purchase.
   * `existingOrder` reuses an owner-approved CONFIRM hold rather than creating a new order.
   */
  private async reserveQuoteAndPurchase(p: {
    agentId: string; connection?: AgentConnection | null; acct: BazaarAccount; solution: any;
    amountMinor: bigint; base: Partial<BuyResult>; capture: Record<string, unknown>;
    input: { confidencePct: number; intentKey?: string }; existingOrder?: BazaarOrder;
  }): Promise<BuyResult> {
    const { agentId, connection, acct, solution: s, amountMinor, base, capture, input, existingOrder } = p;
    const reserved = await this.prisma.$transaction(async (tx) => {
      if (connection) {
        await tx.$queryRaw`SELECT id FROM "AgentConnection" WHERE id = ${connection.id} FOR UPDATE`;
        const fresh = await tx.agentConnection.findUniqueOrThrow({ where: { id: connection.id } });
        // Exclude the hold being approved so its own reservation isn't double-counted against the daily cap.
        const problems = await this.gas.mandateProblems(tx, fresh, BAZAAR_SERVICE_ID, amountMinor, { excludeBazaarOrderId: existingOrder?.id });
        if (problems.length) return { problems };
      }
      const order = existingOrder
        ? await tx.bazaarOrder.update({ where: { id: existingOrder.id }, data: { status: 'PENDING', reason: null, quoteId: null, ...capture } })
        : await tx.bazaarOrder.create({ data: { agentId, connectionId: connection?.id ?? null, solutionId: s.id, amountMinor, currency: 'USD', ...capture } });
      return { order };
    });
    if ('problems' in reserved) {
      return { ...base, status: reserved.problems!.includes('APPROVAL_REQUIRED') ? 'APPROVAL_REQUIRED' : 'DECLINED', reasons: reserved.problems! };
    }
    let order = reserved.order!;
    const key = BazaarKey.load(acct.publicKey, acct.encPrivateKey);
    const fail = async (reasons: string[], extra: Partial<BuyResult> = {}): Promise<BuyResult> => {
      order = await this.prisma.bazaarOrder.update({ where: { id: order.id }, data: { status: 'FAILED', reason: reasons.join(',') } });
      return { ...base, status: 'DECLINED', reasons, orderId: order.id, ...extra };
    };

    const q = await this.client.call(key, 'POST', '/v1/quote', { solution_id: s.id }, acct.mandateId!);
    if (q.status !== 200) return fail([String(q.body?.error ?? 'quote_failed')]);
    if (!q.body.body.allowed) return fail(q.body.body.reasons);
    order = await this.prisma.bazaarOrder.update({ where: { id: order.id }, data: { quoteId: q.body.body.qid } });
    return this.completePurchase(order, key, acct.mandateId!, input, base);
  }

  /** Retry a purchase whose outcome was unknown (same quote → same idempotency key at PayPali). */
  async resume(agentId: string, orderId: string, input: { confidencePct: number; intentKey?: string }) {
    const order = await this.prisma.bazaarOrder.findUnique({ where: { id: orderId } });
    if (!order || order.agentId !== agentId) throw err('ORDER_NOT_FOUND');
    if (order.status !== 'PENDING' || !order.quoteId) return this.orderView(order);
    const acct = await this.prisma.bazaarAccount.findUniqueOrThrow({ where: { agentId } });
    return this.completePurchase(order, BazaarKey.load(acct.publicKey, acct.encPrivateKey), acct.mandateId!, input,
      { solution: { id: order.solutionId, name: '', tier: 0, price: Number(order.amountMinor) / 100 }, amountMinor: order.amountMinor, gasEquivalent: this.gas.minorToGas(Number(order.amountMinor)) });
  }

  async run(agentId: string, receiptId: string, input: Record<string, unknown> = {}) {
    const { order, acct } = await this.ownedReceipt(agentId, receiptId);
    const key = BazaarKey.load(acct.publicKey, acct.encPrivateKey);
    const mandateId = (order.receipt as any)?.body?.mandate_id ?? acct.mandateId;
    const r = await this.client.call(key, 'POST', '/v1/invoke', { receipt_id: receiptId, input }, mandateId);
    if (r.status !== 200) throw err('BAZAAR_RUN_FAILED:' + (r.body?.error ?? r.status) + (r.body?.detail ? ':' + r.body.detail : ''));
    return { runId: r.body.run_id, output: r.body.output, runsLeft: r.body.runs_left, vendorProof: r.body.delivery ?? null };
  }

  /** The agent's provisional result. Only the owner's attestation counts toward trust and settles the stake. */
  async report(agentId: string, runId: string, success: boolean, observed?: unknown) {
    if (typeof success !== 'boolean') throw err('SUCCESS_MUST_BE_BOOLEAN');
    const acct = await this.prisma.bazaarAccount.findUnique({ where: { agentId } });
    if (!acct?.mandateId) throw err('BAZAAR_NOT_ENABLED');
    const r = await this.client.call(BazaarKey.load(acct.publicKey, acct.encPrivateKey), 'POST', '/v1/outcomes', { run_id: runId, success, observed: observed ?? null }, acct.mandateId);
    if (r.status !== 200) throw err('BAZAAR_REPORT_FAILED:' + (r.body?.error ?? r.status));
    return { recorded: true, provisional: true, awaiting: 'owner_attestation' };
  }

  // -------------------------------------------------------------------------
  // Owner: pending reports + attestation (never exposed to agents)
  // -------------------------------------------------------------------------
  async pending(ownerId: string) {
    const r = await this.client.call(await this.principalKey(ownerId), 'GET', '/v1/principals/me/pending');
    if (r.status !== 200) throw err('BAZAAR_PENDING_FAILED:' + (r.body?.error ?? r.status));
    return r.body;
  }

  /**
   * The owner's verdict. For listings with an outcome metric the owner must supply what THEY observed
   * (`observed`); the Bazaar decides success from that number and flags any mismatch with the agent's claim.
   */
  async attest(ownerId: string, runId: string, verdict?: 'confirm' | 'dispute', note?: string, observed?: number) {
    if (verdict !== undefined && verdict !== 'confirm' && verdict !== 'dispute') throw err('VERDICT_MUST_BE_CONFIRM_OR_DISPUTE');
    if (observed !== undefined && observed !== null && !(typeof observed === 'number' && Number.isFinite(observed))) throw err('OBSERVED_MUST_BE_NUMBER');
    if (verdict === undefined && (observed === undefined || observed === null)) throw err('VERDICT_OR_OBSERVED_REQUIRED');
    const r = await this.client.call(await this.principalKey(ownerId), 'POST', '/v1/outcomes/attest',
      { run_id: runId, ...(verdict ? { verdict } : {}), ...(typeof observed === 'number' ? { observed } : {}), note });
    if (r.status !== 200) throw err('BAZAAR_ATTEST_FAILED:' + (r.body?.error ?? r.status));
    return r.body;
  }

  /** Claim a non-delivery refund for a receipt (money returns through PayPali Merchant Connect). */
  async refund(agentId: string, receiptId: string) {
    const { order, acct } = await this.ownedReceipt(agentId, receiptId);
    const key = BazaarKey.load(acct.publicKey, acct.encPrivateKey);
    const r = await this.client.call(key, 'POST', `/v1/receipts/${encodeURIComponent(receiptId)}/refund`, {});
    if (r.status !== 200) throw err('BAZAAR_REFUND_REFUSED:' + (r.body?.error ?? r.status) + (r.body?.reason ? ':' + r.body.reason : ''));
    return { orderId: order.id, receiptId, refunded: true, status: r.body.status, chargeId: order.chargeId };
  }

  // -------------------------------------------------------------------------
  // Owner: human-approval flow for CONFIRM holds (purchase policy).
  // A CONFIRM purchase — and anything recurring, paid-access or personal-data —
  // is held as a PENDING order with no quote and nothing charged until the owner
  // decides here. approve() drives that same order through to purchase; reject()
  // closes it. These are OWNER acts; agents can never call them.
  // -------------------------------------------------------------------------

  /** CONFIRM purchases across this owner's agents that are waiting for a human decision. */
  async heldPurchases(ownerId: string) {
    const agents = await this.prisma.agent.findMany({ where: { ownerId }, select: { id: true, name: true } });
    if (!agents.length) return { held: [] as unknown[] };
    const byId = new Map(agents.map((a) => [a.id, a.name]));
    const orders = await this.prisma.bazaarOrder.findMany({
      where: { agentId: { in: agents.map((a) => a.id) }, status: 'PENDING', quoteId: null },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
    const held = orders.filter((o) => (o.reason ?? '').split(',').includes('APPROVAL_REQUIRED')).map((o) => ({
      ...this.orderView(o), agentId: o.agentId, agentName: byId.get(o.agentId) ?? null,
      category: o.category, permission: o.permission, trigger: o.trigger, beneficiary: o.beneficiary,
      item: o.item, vendor: o.vendor, recurring: o.recurring, personalData: o.personalData,
      budgetOwner: o.budgetOwner, onFailure: o.onFailure, amountMinor: o.amountMinor,
    }));
    return { held };
  }

  /** The owner confirms a held CONFIRM purchase: records the approval, then completes the purchase. */
  async approve(ownerId: string, orderId: string, input: { confidencePct?: number; intentKey?: string } = {}): Promise<BuyResult> {
    const order = await this.heldOrderForOwner(ownerId, orderId);
    await this.recordApproval(ownerId, order);
    const sol = await this.client.call(null, 'GET', `/v1/solutions/${encodeURIComponent(order.solutionId)}`);
    if (sol.status !== 200) {
      const failed = await this.prisma.bazaarOrder.update({ where: { id: order.id }, data: { status: 'FAILED', reason: 'SOLUTION_NOT_FOUND' } });
      return { status: 'DECLINED', reasons: ['SOLUTION_NOT_FOUND'], orderId: failed.id };
    }
    const s = sol.body;
    const amountMinor = BigInt(s.price_minor);
    const base = { solution: { id: s.id, name: s.name, tier: s.verification?.tier, price: s.price }, amountMinor, gasEquivalent: this.gas.minorToGas(s.price_minor) };
    const connection = order.connectionId ? await this.prisma.agentConnection.findUnique({ where: { id: order.connectionId } }) : null;
    const acct = await this.ready(order.agentId, connection);
    const capture = {
      category: order.category, permission: order.permission, trigger: order.trigger, beneficiary: order.beneficiary,
      item: s.name ?? order.item, vendor: s.vendor?.display_name ?? s.seller ?? order.vendor,
      recurring: order.recurring, personalData: order.personalData, budgetOwner: order.budgetOwner, onFailure: order.onFailure,
    };
    const confidencePct = Number.isInteger(input.confidencePct) ? (input.confidencePct as number) : 75;
    return this.reserveQuoteAndPurchase({ agentId: order.agentId, connection, acct, solution: s, amountMinor, base, capture, input: { confidencePct, intentKey: input.intentKey }, existingOrder: order });
  }

  /** The owner declines a held CONFIRM purchase. Nothing was ever charged. */
  async reject(ownerId: string, orderId: string, reason?: string) {
    const order = await this.heldOrderForOwner(ownerId, orderId);
    const note = reason && String(reason).trim() ? [String(reason).trim().slice(0, 120)] : [];
    const updated = await this.prisma.bazaarOrder.update({ where: { id: order.id }, data: { status: 'FAILED', reason: ['OWNER_REJECTED', ...note].join(',') } });
    return this.orderView(updated);
  }

  private async heldOrderForOwner(ownerId: string, orderId: string): Promise<BazaarOrder> {
    const order = await this.prisma.bazaarOrder.findUnique({ where: { id: orderId } });
    if (!order) throw err('ORDER_NOT_FOUND');
    const agent = await this.prisma.agent.findUnique({ where: { id: order.agentId } });
    if (!agent || agent.ownerId !== ownerId) throw err('AGENT_NOT_OWNED');
    // Only a CONFIRM hold (PENDING, no quote yet, awaiting approval) qualifies — not an in-flight or settled order.
    if (order.status !== 'PENDING' || order.quoteId || !(order.reason ?? '').split(',').includes('APPROVAL_REQUIRED')) throw err('NOT_AWAITING_APPROVAL');
    return order;
  }

  /** Durable record that a human authorized this purchase (reuses the HumanApproval model). */
  private async recordApproval(ownerId: string, order: BazaarOrder) {
    const fingerprint = createHash('sha256')
      .update([order.id, order.agentId, order.solutionId, order.amountMinor.toString(), order.currency].join('|'), 'utf8')
      .digest('hex');
    await this.prisma.humanApproval.create({ data: { ownerId, policyVersion: 0, fingerprint } });
  }

  // -------------------------------------------------------------------------
  private async completePurchase(order: BazaarOrder, key: BazaarKey, mandateId: string, input: { confidencePct: number; intentKey?: string }, base: Partial<BuyResult>): Promise<BuyResult> {
    const body = { quote_id: order.quoteId, confidence_pct: input.confidencePct, ...(input.intentKey ? { intent_key: input.intentKey } : {}) };
    let p = await this.client.call(key, 'POST', '/v1/purchase', body, mandateId).catch(() => null);
    if (!p || p.status === 502) p = await this.client.call(key, 'POST', '/v1/purchase', body, mandateId).catch(() => null);   // same quote: no double charge
    if (!p || p.status >= 500) {
      return { ...base, status: 'PENDING', reasons: ['PAYMENT_OUTCOME_UNKNOWN'], orderId: order.id };
    }
    if (p.status !== 200) {
      const reasons = Array.isArray(p.body?.reasons) && p.body.reasons.length ? p.body.reasons : [String(p.body?.error ?? 'purchase_failed')];
      const failed = await this.prisma.bazaarOrder.update({ where: { id: order.id }, data: { status: 'FAILED', reason: reasons.join(',') } });
      return { ...base, status: 'DECLINED', reasons, orderId: failed.id, scoreQuote: p.body?.score_quote ?? undefined };
    }
    const doc = p.body;
    const verified = verifyMarketDoc(doc, await this.client.cachedMarketPub());
    if (!verified) {
      await this.prisma.bazaarOrder.update({ where: { id: order.id }, data: { status: 'FAILED', reason: 'RECEIPT_SIGNATURE_INVALID', receipt: doc } });
      return { ...base, status: 'FAILED', reasons: ['RECEIPT_SIGNATURE_INVALID'], orderId: order.id };
    }
    const pay = doc.body.payment ?? {};
    const paid = await this.prisma.bazaarOrder.update({
      where: { id: order.id },
      data: { status: 'PAID', receiptId: doc.body.rid, chargeId: pay.charge_id ?? null, stakeId: pay.stake_id ?? null, receipt: doc as Prisma.InputJsonValue },
    });
    return { ...base, status: 'PAID', reasons: [], orderId: paid.id, receiptId: doc.body.rid, chargeId: paid.chargeId, stakeId: paid.stakeId, runsIncluded: doc.body.runs_included, receiptVerified: true };
  }

  /** A usable mandate, renewing it (or enabling from the connection's mandate) when needed. */
  private async ready(agentId: string, connection?: AgentConnection | null): Promise<BazaarAccount> {
    const acct = await this.prisma.bazaarAccount.findUnique({ where: { agentId } });
    if (acct?.disabledAt) throw err('BAZAAR_DISABLED_BY_OWNER');
    const live = acct?.mandateId && acct.mandateExpiresAt && acct.mandateExpiresAt.getTime() - this.now().getTime() > RENEW_BEFORE_MS;
    if (live) return acct!;
    if (acct?.mandateId || connection) {
      // Renew with the last settings, or derive them from the connection the owner approved.
      const budget = acct?.mandateId ? acct.budgetMinor : clampBig(connection!.maxDailyMinor * 30n, 1n, MAX_BUDGET);
      const cap = acct?.mandateId ? acct.capMinor : connection!.maxPerTxMinor;
      await this.enable(acct?.ownerId ?? connection!.ownerId, agentId, { budgetMinor: budget, capMinor: cap < budget ? cap : budget, minTier: acct?.minTier ?? 1 });
      return this.prisma.bazaarAccount.findUniqueOrThrow({ where: { agentId } });
    }
    throw err('BAZAAR_NOT_ENABLED');
  }

  private async ownedReceipt(agentId: string, receiptId: string) {
    const order = await this.prisma.bazaarOrder.findFirst({ where: { agentId, receiptId, status: 'PAID' } });
    if (!order) throw err('RECEIPT_NOT_FOUND');
    const acct = await this.prisma.bazaarAccount.findUniqueOrThrow({ where: { agentId } });
    return { order, acct };
  }

  private async principalKey(ownerId: string): Promise<BazaarKey> {
    const row = await this.prisma.bazaarPrincipal.findUnique({ where: { ownerId } });
    if (row) return BazaarKey.load(row.publicKey, row.encPrivateKey);
    const g = BazaarKey.generate();
    try {
      await this.prisma.bazaarPrincipal.create({ data: { ownerId, publicKey: g.publicKey, encPrivateKey: g.encPrivateKey } });
      return g.key;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return this.principalKey(ownerId);
      throw e;
    }
  }

  private async agentKey(ownerId: string, agentId: string) {
    const row = await this.prisma.bazaarAccount.findUnique({ where: { agentId } });
    if (row) return { account: row, key: BazaarKey.load(row.publicKey, row.encPrivateKey) };
    const g = BazaarKey.generate();
    const account = await this.prisma.bazaarAccount.upsert({ where: { agentId }, update: {}, create: { agentId, ownerId, publicKey: g.publicKey, encPrivateKey: g.encPrivateKey } });
    return { account, key: BazaarKey.load(account.publicKey, account.encPrivateKey) };
  }

  private accountView(a: BazaarAccount) {
    const live = !!a.mandateId && !!a.mandateExpiresAt && a.mandateExpiresAt > this.now();
    return { enabled: live, disabledByOwner: !!a.disabledAt, agentKey: a.publicKey, mandateId: a.mandateId, grantId: a.grantId, expiresAt: a.mandateExpiresAt,
      budgetMinor: a.budgetMinor, perPurchaseCapMinor: a.capMinor, minTier: a.minTier };
  }

  orderView(o: BazaarOrder) {
    return { orderId: o.id, solutionId: o.solutionId, status: o.status, reasons: o.reason ? o.reason.split(',') : [], amountMinor: o.amountMinor,
      receiptId: o.receiptId, chargeId: o.chargeId, stakeId: o.stakeId, connectionId: o.connectionId, createdAt: o.createdAt };
  }
}

function clampBig(v: bigint, lo: bigint, hi: bigint) {
  return v < lo ? lo : v > hi ? hi : v;
}
