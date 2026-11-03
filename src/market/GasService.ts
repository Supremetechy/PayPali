import { AgentConnection, Prisma, PrismaClient, ServiceOrder } from '@prisma/client';
import { AgentWalletService } from '../services/AgentWalletService';
import { ScoreService, Settlement } from '../agentdev/ScoreService';
import { ParamSpec, SERVICES, ServiceAction, ServiceDef, findAction, findService } from './catalog';
import { PortalRegistry, makePortalRegistry } from './portals';

// ---------------------------------------------------------------------------
// Gas — PayPali's unit of cost for agent usage.
//
//   1 Gas = gasPriceMilli / 1000 minor units   (starts at 100 → 1 Gas = $0.001; floats with demand, see GasPrice.ts)
//   fee   = max(minFeeGas, ceil(gas × feeBps / 10 000))       network fee, in Gas
//   total = gas + fee  →  amountMinor = ceil(total × gasPriceMilli / 1000)
//
// estimate() prices an action and stores a short-lived quote. pay() turns a quote
// into an order:
//   1. lock the connection, check its mandate (services, per-tx, rolling 24h, approval)
//   2. create the order (one per quote — replays are idempotent)
//   3. Score gate: commit a `market.service` stake (points + wallet bond)
//   4. move the Gas: agent wallet → the service's settlement account (escrow)
//   5. call the service's Agent Portal; FULFILLED settles the stake WON,
//      FAILED refunds the agent and settles LOST, PENDING waits for the provider.
// Placeholder portals are refused at step 0 (PROVIDER_NOT_CONNECTED): no stake, no money.
// ---------------------------------------------------------------------------

export interface GasConfig {
  gasPriceMilli: number;
  feeBps: number;
  minFeeGas: number;
  quoteTtlMs: number;
  stakeTtlMs: number;
}

export const DEFAULT_GAS: GasConfig = { gasPriceMilli: 100, feeBps: 150, minFeeGas: 10, quoteTtlMs: 5 * 60_000, stakeTtlMs: 86_400_000 };

export type PayStatus = 'FULFILLED' | 'PENDING_PROVIDER' | 'FAILED' | 'DECLINED' | 'UNSUPPORTED' | 'APPROVAL_REQUIRED';

export interface PayResult {
  status: PayStatus;
  reasons: string[];
  orderId?: string;
  serviceId: string;
  actionId: string;
  amountMinor: bigint;
  currency: string;
  gas: { units: number; fee: number; total: number };
  stakeId?: string | null;
  scoreQuote?: unknown;
  settlement?: Settlement;
  fulfillment?: unknown;
  sandbox?: boolean;
  replayed: boolean;
}

export const PAY_CAPABILITY = 'market.service';
const err = (code: string) => new Error(code);

export class GasService {
  readonly cfg: GasConfig;
  private readonly settlement = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly wallet: AgentWalletService,
    private readonly score: ScoreService,
    private readonly portals: PortalRegistry = makePortalRegistry(),
    cfg: Partial<GasConfig> = {},
    private readonly now: () => Date = () => new Date()
  ) {
    this.cfg = { ...DEFAULT_GAS, ...cfg };
  }

  /** Public catalog with each service's live portal status. */
  listServices(filter: { query?: string; category?: string } = {}) {
    const q = (filter.query ?? '').toLowerCase().trim();
    return SERVICES.filter((s) => (!filter.category || s.category === filter.category) &&
      (!q || `${s.name} ${s.category} ${s.description} ${s.actions.map((a) => a.name).join(' ')}`.toLowerCase().includes(q)))
      .map((s) => this.view(s));
  }

  getService(id: string) {
    const s = findService(id);
    if (!s) throw err('SERVICE_NOT_FOUND');
    return this.view(s);
  }

  /** The Gas price right now (milli-minor per Gas). It floats; every quote and call locks the price it was made at. */
  get priceMilli(): number { return this.cfg.gasPriceMilli; }

  gasToMinor(gas: number): bigint {
    return this.gasToMinorAt(gas, this.cfg.gasPriceMilli);
  }

  gasToMinorAt(gas: number, priceMilli: number): bigint {
    return BigInt(Math.ceil((gas * priceMilli) / 1000));
  }

  minorToGas(minor: number): number {
    return Math.ceil((minor * 1000) / this.cfg.gasPriceMilli);
  }

  // -------------------------------------------------------------------------
  // ESTIMATE → stored quote (no money, no stake)
  // -------------------------------------------------------------------------
  async estimate(agentId: string, input: { serviceId: string; actionId: string; params?: Record<string, unknown>; currency?: string }, connection?: AgentConnection | null) {
    const s = findService(input.serviceId);
    if (!s) throw err('SERVICE_NOT_FOUND');
    const a = findAction(s, input.actionId);
    if (!a) throw err('ACTION_NOT_FOUND');
    const params = validateParams(a, input.params ?? {});
    const currency = input.currency ?? connection?.currency ?? 'USD';
    if (currency !== 'USD') throw err('CURRENCY_NOT_SUPPORTED');
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw err('AGENT_NOT_FOUND');

    const gasUnits = a.kind === 'fixed' ? a.gas! : this.minorToGas((a.meteredBy ?? []).reduce((sum, k) => sum + (Number(params[k]) || 0), 0));
    if (!(gasUnits > 0)) throw err('NOTHING_TO_PAY');
    const feeGas = Math.max(this.cfg.minFeeGas, Math.ceil((gasUnits * this.cfg.feeBps) / 10_000));
    const amountMinor = this.gasToMinor(gasUnits + feeGas);

    const quote = await this.prisma.gasQuote.create({
      data: {
        agentId, connectionId: connection?.id ?? null, serviceId: s.id, actionId: a.id, params: params as Prisma.InputJsonValue,
        gasUnits, feeGas, gasPriceMilli: this.cfg.gasPriceMilli, amountMinor, currency,
        expiresAt: new Date(this.now().getTime() + this.cfg.quoteTtlMs),
      },
    });
    const portal = this.portals.portalFor(s.id);
    const blockers: string[] = [];
    if (portal.status === 'placeholder') blockers.push('PROVIDER_NOT_CONNECTED');
    if (connection) blockers.push(...(await this.mandateProblems(this.prisma, connection, s.id, amountMinor, { recurring: !!a.recurring })).filter((r) => r !== 'APPROVAL_REQUIRED'));
    return {
      quoteId: quote.id,
      service: { id: s.id, name: s.name }, action: { id: a.id, name: a.name, recurring: a.recurring ?? null },
      gas: { units: gasUnits, fee: feeGas, total: gasUnits + feeGas, priceMilliMinor: this.cfg.gasPriceMilli },
      amountMinor, currency, expiresAt: quote.expiresAt,
      portal: portal.status,
      payable: blockers.length === 0,
      blockers,
      needsApproval: !!(connection?.approvalAboveMinor != null && amountMinor > connection.approvalAboveMinor),
    };
  }

  // -------------------------------------------------------------------------
  // PAY
  // -------------------------------------------------------------------------
  async pay(agentId: string, input: { quoteId: string; confidencePct: number; intentKey?: string }, connection?: AgentConnection | null): Promise<PayResult> {
    const q = await this.prisma.gasQuote.findUnique({ where: { id: input.quoteId } });
    if (!q || q.agentId !== agentId) throw err('QUOTE_NOT_FOUND');
    if ((q.connectionId ?? null) !== (connection?.id ?? null)) throw err('QUOTE_NOT_FOUND'); // a quote is bound to the channel that made it
    const base = {
      serviceId: q.serviceId, actionId: q.actionId, amountMinor: q.amountMinor, currency: q.currency,
      gas: { units: q.gasUnits, fee: q.feeGas, total: q.gasUnits + q.feeGas },
    };

    const existing = await this.prisma.serviceOrder.findUnique({ where: { quoteId: q.id } });
    if (existing) return this.orderView(existing, base, true);
    if (q.expiresAt <= this.now()) return { ...base, status: 'DECLINED', reasons: ['QUOTE_EXPIRED'], replayed: false };

    const portal = this.portals.portalFor(q.serviceId);
    if (portal.status === 'placeholder') {
      // Spec: an unsupported provider returns an unsupported result — never a simulated payment.
      return { ...base, status: 'UNSUPPORTED', reasons: ['PROVIDER_NOT_CONNECTED'], replayed: false };
    }
    let portalSecret: string | undefined;
    if (portal.requiresSecret) {
      portalSecret = await this.portals.secretFor?.(q.serviceId) ?? undefined;
      if (!portalSecret) return { ...base, status: 'UNSUPPORTED', reasons: ['PROVIDER_CREDENTIAL_NOT_CONFIGURED'], replayed: false };
    }

    // 1+2. Mandate under a connection lock, then the order (the quote's single use).
    let order: ServiceOrder;
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        if (connection) {
          await tx.$queryRaw`SELECT id FROM "AgentConnection" WHERE id = ${connection.id} FOR UPDATE`;
          const fresh = await tx.agentConnection.findUniqueOrThrow({ where: { id: connection.id } });
          const recurring = !!findAction(findService(q.serviceId)!, q.actionId)?.recurring;
          const problems = await this.mandateProblems(tx, fresh, q.serviceId, q.amountMinor, { recurring });
          if (problems.length) return { problems };
        }
        return {
          order: await tx.serviceOrder.create({
            data: {
              quoteId: q.id, agentId, connectionId: connection?.id ?? null, serviceId: q.serviceId, actionId: q.actionId,
              gasUnits: q.gasUnits, feeGas: q.feeGas, amountMinor: q.amountMinor, currency: q.currency,
            },
          }),
        };
      });
      if ('problems' in created) {
        const approval = created.problems!.includes('APPROVAL_REQUIRED');
        return { ...base, status: approval ? 'APPROVAL_REQUIRED' : 'DECLINED', reasons: created.problems!, replayed: false };
      }
      order = created.order!;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const raced = await this.prisma.serviceOrder.findUniqueOrThrow({ where: { quoteId: q.id } });
        return this.orderView(raced, base, true);
      }
      throw e;
    }

    // 3. Score gate.
    let stakeId: string;
    try {
      const c = await this.score.commit({
        agentId, capability: PAY_CAPABILITY, intentKey: input.intentKey?.trim() || `svc:${q.serviceId}:${q.actionId}:${q.id}`,
        confidencePct: input.confidencePct, amountMinor: q.amountMinor, currency: q.currency, ttlMs: this.cfg.stakeTtlMs,
      });
      stakeId = c.stakeId;
    } catch (e) {
      const sq = (e as { quote?: { reasons: string[] } }).quote;
      const reasons = sq ? sq.reasons : [e instanceof Error ? e.message : 'SCORE_GATE_ERROR'];
      const failed = await this.prisma.serviceOrder.update({ where: { id: order.id }, data: { status: 'FAILED', reason: reasons.join(',') } });
      return { ...this.orderView(failed, base, false), status: 'DECLINED', scoreQuote: sq };
    }
    order = await this.prisma.serviceOrder.update({ where: { id: order.id }, data: { stakeId } });

    // 4. Escrow the Gas.
    const escrow = await this.settlementAgent(q.serviceId);
    try {
      const t = await this.wallet.send({ fromAgentId: agentId, toAgentId: escrow, amountMinor: q.amountMinor, currency: q.currency, idempotencyKey: `gas:${order.id}` });
      order = await this.prisma.serviceOrder.update({ where: { id: order.id }, data: { transferId: t.transferId } });
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'TRANSFER_FAILED';
      const failed = await this.prisma.serviceOrder.update({ where: { id: order.id }, data: { status: 'FAILED', reason } });
      const settlement = await this.score.settle(stakeId, { success: false, evidence: { reason, orderId: order.id } });
      return { ...this.orderView(failed, base, false), settlement };
    }

    // 5. The service's Agent Portal.
    const result = await portal.fulfil({
      orderId: order.id, serviceId: q.serviceId, actionId: q.actionId, params: q.params as Record<string, unknown>,
      amountMinor: q.amountMinor, currency: q.currency, agentId,
    }, portalSecret).catch((): { status: 'PENDING'; details: Record<string, unknown> } => ({ status: 'PENDING', details: { error: 'PROVIDER_REQUEST_FAILED' } }));

    if (result.status === 'FULFILLED') {
      order = await this.prisma.serviceOrder.update({ where: { id: order.id }, data: { status: 'FULFILLED', fulfillment: result as unknown as Prisma.InputJsonValue } });
      const settlement = await this.score.settle(stakeId, { success: true, evidence: { orderId: order.id, providerRef: result.providerRef } });
      return { ...this.orderView(order, base, false), settlement, sandbox: portal.status === 'sandbox' };
    }
    if (result.status === 'FAILED') {
      const refund = await this.wallet.send({ fromAgentId: escrow, toAgentId: agentId, amountMinor: q.amountMinor, currency: q.currency, idempotencyKey: `gasrefund:${order.id}` });
      order = await this.prisma.serviceOrder.update({ where: { id: order.id }, data: { status: 'FAILED', reason: result.reason, refundId: refund.transferId, fulfillment: result as unknown as Prisma.InputJsonValue } });
      const settlement = await this.score.settle(stakeId, { success: false, evidence: { reason: result.reason, orderId: order.id } });
      return { ...this.orderView(order, base, false), settlement, sandbox: portal.status === 'sandbox' };
    }
    // PENDING: the provider confirms later; the stake stays OPEN and expires as a loss if it never does.
    order = await this.prisma.serviceOrder.update({ where: { id: order.id }, data: { status: 'PENDING_PROVIDER', fulfillment: result as unknown as Prisma.InputJsonValue } });
    return { ...this.orderView(order, base, false), sandbox: portal.status === 'sandbox' };
  }

  async getOrder(agentId: string, orderId: string) {
    const o = await this.prisma.serviceOrder.findUnique({ where: { id: orderId } });
    if (!o || o.agentId !== agentId) throw err('ORDER_NOT_FOUND');
    return this.orderView(o, { serviceId: o.serviceId, actionId: o.actionId, amountMinor: o.amountMinor, currency: o.currency, gas: { units: o.gasUnits, fee: o.feeGas, total: o.gasUnits + o.feeGas } }, false);
  }

  /**
   * Provider confirmation webhook: a service's Agent Portal confirms (or rejects) a
   * PENDING_PROVIDER order later, settling the still-OPEN Score stake and, on failure,
   * refunding the escrowed Gas to the agent. Idempotent: a replay once the order has
   * left PENDING_PROVIDER just returns the current state, so re-delivery is harmless.
   * The caller (an HTTP webhook) must authenticate the provider before calling this.
   */
  async confirmOrder(orderId: string, outcome: { success: boolean; providerRef?: string; reason?: string }): Promise<PayResult & { settled?: boolean }> {
    const o = await this.prisma.serviceOrder.findUnique({ where: { id: orderId } });
    if (!o) throw err('ORDER_NOT_FOUND');
    const base = { serviceId: o.serviceId, actionId: o.actionId, amountMinor: o.amountMinor, currency: o.currency, gas: { units: o.gasUnits, fee: o.feeGas, total: o.gasUnits + o.feeGas } };
    if (o.status !== 'PENDING_PROVIDER') return { ...this.orderView(o, base, false), settled: false };

    const fulfillment = { status: outcome.success ? 'FULFILLED' : 'FAILED', providerRef: outcome.providerRef, reason: outcome.reason, confirmedAt: this.now().toISOString() };
    if (outcome.success) {
      const order = await this.prisma.serviceOrder.update({ where: { id: o.id }, data: { status: 'FULFILLED', fulfillment: fulfillment as unknown as Prisma.InputJsonValue } });
      const settlement = o.stakeId ? await this.score.settle(o.stakeId, { success: true, evidence: { orderId: o.id, providerRef: outcome.providerRef } }) : undefined;
      return { ...this.orderView(order, base, false), settlement, settled: true };
    }
    // Provider rejected: return the escrowed Gas to the agent and settle the stake as a loss.
    const escrow = await this.settlementAgent(o.serviceId);
    const refund = await this.wallet.send({ fromAgentId: escrow, toAgentId: o.agentId, amountMinor: o.amountMinor, currency: o.currency, idempotencyKey: `gasrefund:${o.id}` });
    const order = await this.prisma.serviceOrder.update({ where: { id: o.id }, data: { status: 'FAILED', reason: outcome.reason ?? 'PROVIDER_REJECTED', refundId: refund.transferId, fulfillment: fulfillment as unknown as Prisma.InputJsonValue } });
    const settlement = o.stakeId ? await this.score.settle(o.stakeId, { success: false, evidence: { reason: outcome.reason ?? 'PROVIDER_REJECTED', orderId: o.id } }) : undefined;
    return { ...this.orderView(order, base, false), settlement, settled: true };
  }

  /** Spent through this connection in the rolling 24h window, across Gas services AND AgentBazaar (paid or in flight). */
  async spentLast24h(connectionId: string, db: Prisma.TransactionClient | PrismaClient = this.prisma, opts: { excludeBazaarOrderId?: string } = {}): Promise<bigint> {
    const since = new Date(this.now().getTime() - 86_400_000);
    const [svc, bz, held, done] = await Promise.all([
      db.serviceOrder.aggregate({ _sum: { amountMinor: true }, where: { connectionId, createdAt: { gte: since }, status: { in: ['PROCESSING', 'FULFILLED', 'PENDING_PROVIDER'] } } }),
      db.bazaarOrder.aggregate({ _sum: { amountMinor: true }, where: { connectionId, createdAt: { gte: since }, status: { in: ['PENDING', 'PAID'] }, ...(opts.excludeBazaarOrderId ? { id: { not: opts.excludeBazaarOrderId } } : {}) } }),
      // Data queries: in flight count at their hold, answered/settled at what was actually charged.
      db.dataQuery.aggregate({ _sum: { heldMinor: true }, where: { connectionId, createdAt: { gte: since }, status: 'PENDING' } }),
      db.dataQuery.aggregate({ _sum: { amountMinor: true }, where: { connectionId, createdAt: { gte: since }, status: { in: ['ANSWERED', 'SETTLED'] } } }),
    ]);
    return (svc._sum.amountMinor ?? 0n) + (bz._sum.amountMinor ?? 0n) + (held._sum.heldMinor ?? 0n) + (done._sum.amountMinor ?? 0n);
  }

  async mandateProblems(db: Prisma.TransactionClient | PrismaClient, c: AgentConnection, serviceId: string, amountMinor: bigint, opts: { recurring?: boolean; excludeBazaarOrderId?: string } = {}): Promise<string[]> {
    const r: string[] = [];
    if (c.status !== 'ACTIVE') r.push('CONNECTION_REVOKED');
    if (c.expiresAt && c.expiresAt <= this.now()) r.push('CONNECTION_EXPIRED');
    if (!serviceAllowed(c.allowedServices, serviceId)) r.push('MANDATE_SERVICE_NOT_ALLOWED');
    if (opts.recurring && !c.allowRecurring) r.push('MANDATE_RECURRING_NOT_ALLOWED');
    if (amountMinor > c.maxPerTxMinor) r.push('MANDATE_PER_TX_LIMIT');
    if ((await this.spentLast24h(c.id, db, { excludeBazaarOrderId: opts.excludeBazaarOrderId })) + amountMinor > c.maxDailyMinor) r.push('MANDATE_DAILY_LIMIT');
    if (!r.length && c.approvalAboveMinor != null && amountMinor > c.approvalAboveMinor) r.push('APPROVAL_REQUIRED');
    return r;
  }

  async settlementAgent(serviceId: string): Promise<string> {
    const cached = this.settlement.get(serviceId);
    if (cached) return cached;
    const email = `service+${serviceId}@paypali.system`;
    const owner = await this.prisma.owner.upsert({ where: { email }, update: {}, create: { email } });
    const name = `Service settlement: ${serviceId}`;
    const agent = (await this.prisma.agent.findFirst({ where: { ownerId: owner.id, name } })) ?? (await this.prisma.agent.create({ data: { ownerId: owner.id, name } }));
    this.settlement.set(serviceId, agent.id);
    return agent.id;
  }

  private view(s: ServiceDef) {
    const portal = this.portals.portalFor(s.id);
    return {
      id: s.id, name: s.name, category: s.category, description: s.description,
      portal: { ...s.portal, status: portal.status },
      actions: s.actions.map((a) => ({
        id: a.id, name: a.name, description: a.description, kind: a.kind, recurring: a.recurring ?? null,
        gas: a.kind === 'fixed' ? a.gas : null,
        approxMinor: a.kind === 'fixed' ? this.gasToMinor(a.gas!) : null,
        params: a.params ?? {},
      })),
    };
  }

  private orderView(o: ServiceOrder, base: Omit<PayResult, 'status' | 'reasons' | 'replayed'>, replayed: boolean): PayResult {
    const status: PayStatus = o.status === 'PROCESSING' ? 'PENDING_PROVIDER' : o.status;
    return { ...base, status, reasons: o.reason ? o.reason.split(',') : [], orderId: o.id, stakeId: o.stakeId, fulfillment: o.fulfillment ?? undefined, replayed };
  }
}

function validateParams(a: ServiceAction, raw: Record<string, unknown>): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw err('INVALID_PARAMS');
  const spec: Record<string, ParamSpec> = a.params ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(spec)) {
    const v = raw[k];
    if (v === undefined || v === null || v === '') {
      if (p.required) throw err(`MISSING_PARAM:${k}`);
      continue;
    }
    if (p.type === 'integer') {
      if (!Number.isInteger(v) || (p.minimum !== undefined && (v as number) < p.minimum) || (p.maximum !== undefined && (v as number) > p.maximum)) throw err(`INVALID_PARAM:${k}`);
    } else if (typeof v !== 'string' || v.length > 300) throw err(`INVALID_PARAM:${k}`);
    out[k] = v;
  }
  if (raw.sandbox_fail === true) out.sandbox_fail = true; // dev knob honored only by SandboxPortal
  return out;
}

/** "*" allows everything; "data:*" allows every company data agent; otherwise an exact id. */
export function serviceAllowed(allowed: string[], serviceId: string): boolean {
  if (allowed.includes('*') || allowed.includes(serviceId)) return true;
  return serviceId.startsWith('data:') && allowed.includes('data:*');
}
