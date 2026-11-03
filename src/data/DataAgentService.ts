import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AgentConnection, DataAgent, DataQuery, DataQuestionType, Prisma, PrismaClient } from '@prisma/client';
import { AgentDevService } from '../agentdev/AgentDevService';
import { AgentWalletService } from '../services/AgentWalletService';
import { GasService } from '../market/GasService';
import { KycService } from '../bazaar/KycService';
import { IdentityIssuer, SignedDoc } from '../bazaar/IdentityIssuer';
import { openSecret, sealSecret, sha256hex, canon } from '../bazaar/keys';
import { RiskClass } from '@prisma/client';
import {
  JsonSchema, Pricing, PrivacyRules, PURPOSE, QuestionTypeInput, SELF_ACCESS,
  maxRowsFor, meter, parseQuestionType, privacyViolations, validate,
} from './contract';

// ---------------------------------------------------------------------------
// Company data agents: one agent in front of a company's databases, selling
// answers (not rows) per question type, paid in Gas per query.
//
//   buyer agent ──quote/query──▶ PayPali ──signed POST──▶ company endpoint
//                                  │  ◀──signed answer──┘
//                                  ├─ contract checks (schema, banned fields, aggregation floor, freshness)
//                                  ├─ meter (rows / compute) → refund the unused hold
//                                  ├─ seller stakes Score at its accuracy claim
//                                  └─ escrow until the dispute window closes → batched settlement
//                                       fee → PayPali, splits → data sources, rest → company
//
// The result itself is never stored by PayPali: only its sha256, in a signed receipt.
// ---------------------------------------------------------------------------

export type DataFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  Promise<{ status: number; headers: { get(k: string): string | null }; text(): Promise<string> }>;

export interface DataAgentConfig {
  /** Permit http:// and loopback endpoints (local dev only). */
  allowInsecureEndpoints: boolean;
  endpointTimeoutMs: number;
  /** Max bytes of an answer. */
  maxResultBytes: number;
  /** A PENDING query older than this is failed and refunded by `recover()`. */
  stuckAfterMs: number;
  /** Require a kyc identity for owners who sell data (payouts go to proven owners). */
  requireKycSellers: boolean;
  /** Queries per settlement batch. */
  batchSize: number;
}

export const DEFAULT_DATA_CONFIG: DataAgentConfig = {
  allowInsecureEndpoints: false, endpointTimeoutMs: 10_000, maxResultBytes: 256 * 1024, stuckAfterMs: 5 * 60_000,
  requireKycSellers: false, batchSize: 500,
};

const err = (code: string) => new Error(code);
const SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;
const HOUR = 3_600_000;

export const dataServiceId = (slug: string) => `data:${slug}`;

/** HMAC over "<a>.<sha256(body)>" — request: a = timestamp; response: a = query id. */
export const signData = (secret: string, a: string, body: string) => 'v1=' + createHmac('sha256', secret).update(`${a}.${sha256hex(body)}`).digest('hex');
const sigEq = (a: string | null, b: string) => !!a && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export interface QueryInput {
  dataAgent: string;          // slug
  questionType: string;       // key
  input: unknown;
  purpose: string;
  confidencePct?: number;     // buyer's Score confidence that the query is worth paying (default 80)
  idempotencyKey?: string;
}

export interface QueryResult {
  queryId: string;
  status: DataQuery['status'] | 'APPROVAL_REQUIRED';
  reasons: string[];
  dataAgent: string;
  questionType: string;
  gas: { price: number; fee: number; max: number };
  heldMinor: bigint;
  amountMinor: bigint;
  result?: unknown;
  usage?: { rows: number; computeMs: number };
  asOf?: Date | null;
  receipt?: SignedDoc<Record<string, unknown>> | { body: Record<string, unknown>; sig: null } | null;
  disputeUntil?: Date | null;
  replayed: boolean;
}

type QT = DataQuestionType & { pricing: Pricing; privacy: PrivacyRules };
const asQT = (q: DataQuestionType) => q as QT;

export class DataAgentService {
  readonly cfg: DataAgentConfig;
  private systemAgents = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly dev: AgentDevService,
    private readonly wallet: AgentWalletService,
    private readonly gas: GasService,
    private readonly fetchFn: DataFetch,
    private readonly identity: { kyc: KycService | null; issuer: IdentityIssuer | null } = { kyc: null, issuer: null },
    cfg: Partial<DataAgentConfig> = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.cfg = { ...DEFAULT_DATA_CONFIG, ...cfg };
  }

  // =========================================================================
  // COMPANY SIDE: register, verify, question types, splits
  // =========================================================================

  /** Owner act. Returns the endpoint secret ONCE; the agent stays PAUSED until `verifyEndpoint` succeeds. */
  async register(ownerId: string, p: { agentId: string; slug: string; name: string; description?: string; endpointUrl: string; disputeWindowHours?: number }) {
    const agent = await this.prisma.agent.findUnique({ where: { id: p.agentId } });
    if (!agent || agent.ownerId !== ownerId) throw err('AGENT_NOT_OWNED');
    if (!agent.isActive) throw err('AGENT_INACTIVE');
    if (typeof p.slug !== 'string' || !SLUG.test(p.slug)) throw err('INVALID_SLUG');
    const name = String(p.name ?? '').trim();
    if (!name || name.length > 80) throw err('INVALID_NAME');
    this.checkEndpoint(p.endpointUrl);
    const hours = p.disputeWindowHours ?? 24;
    if (!(Number.isInteger(hours) && hours >= 1 && hours <= 720)) throw err('INVALID_DISPUTE_WINDOW');
    if (this.cfg.requireKycSellers) await this.requireKyc(ownerId, 'SELLER_KYC_REQUIRED');
    if (await this.prisma.dataAgent.findUnique({ where: { slug: p.slug } })) throw err('SLUG_TAKEN');

    const secret = randomBytes(32).toString('base64url');
    const row = await this.prisma.dataAgent.create({
      data: {
        slug: p.slug, name, description: String(p.description ?? '').trim().slice(0, 2000), ownerId, agentId: p.agentId,
        endpointUrl: p.endpointUrl, endpointSecret: sealSecret(secret), status: 'PAUSED', disputeWindowMs: hours * HOUR,
      },
    });
    // The company stakes on its own accuracy: a Score account and the data.answer capability.
    await this.dev.score.open(p.agentId);
    await this.dev.skills.grantCapability(ownerId, p.agentId, 'data.answer', 'HIGH' as RiskClass);
    return { dataAgent: this.agentView(row), endpointSecret: secret, next: 'Configure the secret on your endpoint, then verify it to go live.' };
  }

  /** Owner act: prove the endpoint holds the secret (signed challenge, signed echo), then go ACTIVE. */
  async verifyEndpoint(ownerId: string, dataAgentId: string) {
    const a = await this.owned(ownerId, dataAgentId);
    const nonce = randomBytes(16).toString('base64url');
    const id = `challenge:${nonce}`;
    const { status, body, sigOk } = await this.call(a, { type: 'challenge', query_id: id, challenge: nonce }, id);
    let echoed: unknown;
    try { echoed = JSON.parse(body).challenge; } catch { /* below */ }
    if (status !== 200 || !sigOk || echoed !== nonce) throw err('ENDPOINT_VERIFICATION_FAILED');
    return this.agentView(await this.prisma.dataAgent.update({ where: { id: a.id }, data: { status: 'ACTIVE' } }));
  }

  async rotateSecret(ownerId: string, dataAgentId: string) {
    const a = await this.owned(ownerId, dataAgentId);
    const secret = randomBytes(32).toString('base64url');
    await this.prisma.dataAgent.update({ where: { id: a.id }, data: { endpointSecret: sealSecret(secret), status: 'PAUSED' } });
    return { endpointSecret: secret, next: 'Configure the new secret, then verify the endpoint again.' };
  }

  async update(ownerId: string, dataAgentId: string, patch: { name?: string; description?: string; endpointUrl?: string; paused?: boolean }) {
    const a = await this.owned(ownerId, dataAgentId);
    const data: Prisma.DataAgentUpdateInput = {};
    if (patch.name !== undefined) { const n = String(patch.name).trim(); if (!n || n.length > 80) throw err('INVALID_NAME'); data.name = n; }
    if (patch.description !== undefined) data.description = String(patch.description).trim().slice(0, 2000);
    if (patch.endpointUrl !== undefined) { this.checkEndpoint(patch.endpointUrl); data.endpointUrl = patch.endpointUrl; data.status = 'PAUSED'; }
    if (patch.paused === true) data.status = 'PAUSED';
    if (patch.paused === false && patch.endpointUrl === undefined && a.status === 'PAUSED') throw err('VERIFY_ENDPOINT_TO_RESUME');
    return this.agentView(await this.prisma.dataAgent.update({ where: { id: a.id }, data }));
  }

  /** Owner act: create or replace a question type by key. Prices and claims are per question type. */
  async upsertQuestionType(ownerId: string, dataAgentId: string, q: QuestionTypeInput) {
    const a = await this.owned(ownerId, dataAgentId);
    const v = parseQuestionType(q);
    const data = {
      title: v.title, description: v.description, inputSchema: v.inputSchema as Prisma.InputJsonValue, outputSchema: v.outputSchema as Prisma.InputJsonValue,
      pricing: v.pricing as unknown as Prisma.InputJsonValue, freshnessSeconds: v.freshnessSeconds, accuracyClaim: v.accuracyClaim,
      privacy: v.privacy as unknown as Prisma.InputJsonValue, allowedPurposes: v.allowedPurposes, subjectQuery: v.subjectQuery, active: v.active,
    };
    const row = await this.prisma.dataQuestionType.upsert({
      where: { dataAgentId_key: { dataAgentId: a.id, key: v.key } }, update: data, create: { dataAgentId: a.id, key: v.key, ...data },
    });
    return this.questionView(asQT(row));
  }

  /** Company owner proposes a revenue share for a data source it aggregates; the source's owner must accept. */
  async proposeSplit(ownerId: string, dataAgentId: string, p: { payeeAgentId: string; label: string; shareBps: number }) {
    const a = await this.owned(ownerId, dataAgentId);
    if (!(Number.isInteger(p.shareBps) && p.shareBps >= 1 && p.shareBps <= 10_000)) throw err('INVALID_SHARE');
    const label = String(p.label ?? '').trim();
    if (!label || label.length > 80) throw err('INVALID_LABEL');
    if (p.payeeAgentId === a.agentId) throw err('SPLIT_TO_SELF');
    const payee = await this.prisma.agent.findUnique({ where: { id: p.payeeAgentId } });
    if (!payee || !payee.isActive) throw err('PAYEE_NOT_FOUND');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "DataAgent" WHERE id = ${a.id} FOR UPDATE`;
      const open = await tx.dataSourceSplit.findMany({ where: { dataAgentId: a.id, status: { in: ['PENDING', 'ACTIVE'] }, payeeAgentId: { not: p.payeeAgentId } } });
      if (open.reduce((s, x) => s + x.shareBps, 0) + p.shareBps > 10_000) throw err('SPLITS_EXCEED_100_PERCENT');
      const row = await tx.dataSourceSplit.upsert({
        where: { dataAgentId_payeeAgentId: { dataAgentId: a.id, payeeAgentId: p.payeeAgentId } },
        // Any change goes back to PENDING: the source accepts the terms it is paid on.
        update: { label, shareBps: p.shareBps, status: 'PENDING', acceptedAt: null },
        create: { dataAgentId: a.id, payeeAgentId: p.payeeAgentId, label, shareBps: p.shareBps },
      });
      return row;
    });
  }

  /** The data source's owner accepts the share (only then is it paid). */
  async acceptSplit(payeeOwnerId: string, splitId: string) {
    const s = await this.prisma.dataSourceSplit.findUnique({ where: { id: splitId } });
    if (!s) throw err('SPLIT_NOT_FOUND');
    const payee = await this.prisma.agent.findUnique({ where: { id: s.payeeAgentId } });
    if (!payee || payee.ownerId !== payeeOwnerId) throw err('SPLIT_NOT_FOUND');
    if (s.status !== 'PENDING') throw err('SPLIT_NOT_PENDING');
    return this.prisma.dataSourceSplit.update({ where: { id: s.id }, data: { status: 'ACTIVE', acceptedAt: this.now() } });
  }

  /** Either side may end a split. Batches already created keep the shares they were created with. */
  async endSplit(ownerId: string, splitId: string) {
    const s = await this.prisma.dataSourceSplit.findUnique({ where: { id: splitId } });
    if (!s) throw err('SPLIT_NOT_FOUND');
    const [a, payee] = await Promise.all([this.prisma.dataAgent.findUnique({ where: { id: s.dataAgentId } }), this.prisma.agent.findUnique({ where: { id: s.payeeAgentId } })]);
    if (a?.ownerId !== ownerId && payee?.ownerId !== ownerId) throw err('SPLIT_NOT_FOUND');
    return this.prisma.dataSourceSplit.update({ where: { id: s.id }, data: { status: 'ENDED' } });
  }

  async splits(ownerId: string) {
    const mine = await this.prisma.dataAgent.findMany({ where: { ownerId }, select: { id: true } });
    const agents = await this.prisma.agent.findMany({ where: { ownerId }, select: { id: true } });
    return this.prisma.dataSourceSplit.findMany({
      where: { OR: [{ dataAgentId: { in: mine.map((x) => x.id) } }, { payeeAgentId: { in: agents.map((x) => x.id) } }] },
      orderBy: { createdAt: 'desc' },
    });
  }

  async ownedAgents(ownerId: string) {
    const rows = await this.prisma.dataAgent.findMany({ where: { ownerId }, include: { questionTypes: true }, orderBy: { createdAt: 'desc' } });
    return Promise.all(rows.map(async (r) => ({ ...this.agentView(r), questionTypes: r.questionTypes.map((q) => this.questionView(asQT(q), true)), stats: await this.stats(r.id) })));
  }

  // =========================================================================
  // DISCOVERY
  // =========================================================================

  async list(q: { query?: string } = {}) {
    const rows = await this.prisma.dataAgent.findMany({ where: { status: 'ACTIVE' }, include: { questionTypes: { where: { active: true } } }, orderBy: { name: 'asc' } });
    const needle = q.query?.toLowerCase().trim();
    const out = [];
    for (const r of rows) {
      if (needle && !`${r.name} ${r.description} ${r.questionTypes.map((x) => `${x.title} ${x.description}`).join(' ')}`.toLowerCase().includes(needle)) continue;
      out.push(await this.publicView(r));
    }
    return out;
  }

  async get(slug: string) {
    const r = await this.prisma.dataAgent.findUnique({ where: { slug }, include: { questionTypes: { where: { active: true } } } });
    if (!r) throw err('DATA_AGENT_NOT_FOUND');
    return this.publicView(r);
  }

  private async publicView(r: DataAgent & { questionTypes: DataQuestionType[] }) {
    const kyc = this.identity.kyc ? await this.identity.kyc.grantFor(r.ownerId).catch(() => null) : null;
    return {
      ...this.agentView(r),
      serviceId: dataServiceId(r.slug),
      sellerAssurance: kyc?.assurance ?? 'none',
      questionTypes: r.questionTypes.map((q) => this.questionView(asQT(q))),
      stats: await this.stats(r.id),
    };
  }

  // =========================================================================
  // BUYER SIDE: quote, query, dispute, subscriptions
  // =========================================================================

  async quote(buyerAgentId: string, p: { dataAgent: string; questionType: string; purpose?: string }, connection?: AgentConnection | null) {
    const { a, q } = await this.resolve(p.dataAgent, p.questionType);
    const price = this.priceFor(q);
    const blockers: string[] = [];
    if (a.status !== 'ACTIVE') blockers.push('DATA_AGENT_PAUSED');
    if (p.purpose !== undefined && !this.purposeOk(q, p.purpose)) blockers.push('PURPOSE_NOT_ALLOWED');
    const sub = await this.prisma.dataSubscription.findUnique({ where: { dataAgentId_buyerAgentId: { dataAgentId: a.id, buyerAgentId } } });
    const activeSub = sub?.status === 'ACTIVE' ? sub : null;
    if (connection) blockers.push(...(await this.gas.mandateProblems(this.prisma, connection, dataServiceId(a.slug), price.heldMinor, { recurring: !!activeSub })).filter((r) => r !== 'APPROVAL_REQUIRED'));
    if (activeSub && (await this.monthSpend(this.prisma, activeSub.id)) + price.heldMinor > activeSub.monthlyBudgetMinor) blockers.push('SUBSCRIPTION_BUDGET_EXCEEDED');
    const sq = await this.dev.score.quote({ agentId: buyerAgentId, capability: 'data.query', intentKey: `data:quote:${a.slug}:${q.key}`, confidencePct: 80, amountMinor: price.heldMinor, currency: 'USD' }).catch((e: Error) => ({ allowed: false, reasons: [e.message] }));
    if (!sq.allowed) blockers.push(...sq.reasons);
    if (q.subjectQuery) {
      const owner = await this.buyerOwner(buyerAgentId);
      const g = this.identity.kyc ? await this.identity.kyc.grantFor(owner).catch(() => null) : null;
      if (!g || g.assurance !== 'kyc') blockers.push('SUBJECT_KYC_REQUIRED');
    }
    return {
      dataAgent: a.slug, questionType: q.key, title: q.title,
      gas: { base: q.pricing.baseGas, perRow: q.pricing.perRowGas, perComputeMs: q.pricing.perComputeMsGas, max: q.pricing.maxGas, maxFee: price.maxFee, maxTotal: q.pricing.maxGas + price.maxFee, model: q.pricing.model },
      heldMinor: price.heldMinor, currency: 'USD', maxRows: maxRowsFor(q.pricing),
      contract: this.contractView(q, a),
      subscription: activeSub ? { id: activeSub.id, monthlyBudgetMinor: activeSub.monthlyBudgetMinor, spentThisMonthMinor: await this.monthSpend(this.prisma, activeSub.id) } : null,
      payable: blockers.length === 0, blockers,
      needsApproval: !!(connection?.approvalAboveMinor != null && price.heldMinor > connection.approvalAboveMinor),
    };
  }

  async query(buyerAgentId: string, input: QueryInput, connection?: AgentConnection | null): Promise<QueryResult> {
    const idem = input.idempotencyKey ?? randomBytes(12).toString('base64url');
    if (typeof idem !== 'string' || idem.length > 120) throw err('INVALID_IDEMPOTENCY_KEY');
    const prior = await this.prisma.dataQuery.findUnique({ where: { buyerAgentId_idempotencyKey: { buyerAgentId, idempotencyKey: idem } } });
    if (prior) return this.queryView(prior, { replayed: true });

    const { a, q } = await this.resolve(input.dataAgent, input.questionType);
    const base = { dataAgent: a.slug, questionType: q.key };
    const confidencePct = input.confidencePct ?? 80;
    if (!(Number.isInteger(confidencePct) && confidencePct >= 1 && confidencePct <= 99)) throw err('INVALID_CONFIDENCE');
    const buyer = await this.prisma.agent.findUnique({ where: { id: buyerAgentId } });
    if (!buyer) throw err('AGENT_NOT_FOUND');
    if (buyer.id === a.agentId) throw err('CANNOT_QUERY_OWN_DATA_AGENT');

    // ---- 1. Contract checks that need no money --------------------------------
    const pre: string[] = [];
    if (a.status !== 'ACTIVE') pre.push('DATA_AGENT_PAUSED');
    if (typeof input.purpose !== 'string' || !PURPOSE.test(input.purpose)) pre.push('PURPOSE_REQUIRED');
    else if (!this.purposeOk(q, input.purpose)) pre.push('PURPOSE_NOT_ALLOWED');
    const inErrs = validate(q.inputSchema as JsonSchema, input.input);
    if (inErrs.length) pre.push('INPUT_INVALID');
    let subject: { subject: string; method: string; notAfter?: number } | null = null;
    if (q.subjectQuery) {
      const g = this.identity.kyc && this.identity.issuer ? await this.identity.kyc.grantFor(buyer.ownerId).catch((e: Error) => ({ error: e.message })) : null;
      if (!g || 'error' in g) pre.push(g && 'error' in g ? g.error : 'SUBJECT_QUERIES_UNAVAILABLE');
      else if (g.assurance !== 'kyc') pre.push('SUBJECT_KYC_REQUIRED');
      else subject = { subject: g.subject, method: g.method, notAfter: g.notAfter };
    }
    const price = this.priceFor(q);
    if (pre.length) return { queryId: '', status: 'REFUSED', reasons: inErrs.length ? [...pre, ...inErrs.slice(0, 5)] : pre, ...base, gas: { price: 0, fee: 0, max: q.pricing.maxGas + price.maxFee }, heldMinor: 0n, amountMinor: 0n, replayed: false };

    // ---- 2. Mandate + subscription budget under locks, then the PENDING row ----
    const sub = await this.prisma.dataSubscription.findUnique({ where: { dataAgentId_buyerAgentId: { dataAgentId: a.id, buyerAgentId } } });
    const activeSub = sub?.status === 'ACTIVE' ? sub : null;
    let row: DataQuery;
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const problems: string[] = [];
        if (connection) {
          await tx.$queryRaw`SELECT id FROM "AgentConnection" WHERE id = ${connection.id} FOR UPDATE`;
          const fresh = await tx.agentConnection.findUniqueOrThrow({ where: { id: connection.id } });
          problems.push(...(await this.gas.mandateProblems(tx, fresh, dataServiceId(a.slug), price.heldMinor, { recurring: !!activeSub })));
        }
        if (activeSub) {
          await tx.$queryRaw`SELECT id FROM "DataSubscription" WHERE id = ${activeSub.id} FOR UPDATE`;
          if ((await this.monthSpend(tx, activeSub.id)) + price.heldMinor > activeSub.monthlyBudgetMinor) problems.push('SUBSCRIPTION_BUDGET_EXCEEDED');
        }
        if (problems.length) return { problems };
        return {
          row: await tx.dataQuery.create({
            data: {
              dataAgentId: a.id, questionTypeId: q.id, buyerAgentId, connectionId: connection?.id ?? null, subscriptionId: activeSub?.id ?? null,
              idempotencyKey: idem, purpose: input.purpose, maxGas: q.pricing.maxGas + price.maxFee, heldMinor: price.heldMinor, amountMinor: 0n,
              subjectVerified: !!subject, createdAt: this.now(),
            },
          }),
        };
      });
      if ('problems' in created) {
        const approval = created.problems!.includes('APPROVAL_REQUIRED');
        return { queryId: '', status: approval ? 'APPROVAL_REQUIRED' : 'REFUSED', reasons: created.problems!, ...base, gas: { price: 0, fee: 0, max: q.pricing.maxGas + price.maxFee }, heldMinor: 0n, amountMinor: 0n, replayed: false };
      }
      row = created.row!;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await this.prisma.dataQuery.findUnique({ where: { buyerAgentId_idempotencyKey: { buyerAgentId, idempotencyKey: idem } } });
        if (again) return this.queryView(again, { replayed: true });
      }
      throw e;
    }
    if (connection) await this.prisma.agentConnection.update({ where: { id: connection.id }, data: { lastUsedAt: this.now() } }).catch(() => undefined);

    // ---- 3. Buyer stake: "this query is worth paying for" ---------------------
    let buyerStakeId: string;
    try {
      buyerStakeId = (await this.dev.score.commit({
        agentId: buyerAgentId, capability: 'data.query', intentKey: `data:${row.id}`, confidencePct,
        amountMinor: price.heldMinor, currency: 'USD', ttlMs: a.disputeWindowMs + 86_400_000,
      })).stakeId;
    } catch (e) {
      const quote = (e as { quote?: { reasons: string[] } }).quote;
      return this.finish(row, 'REFUSED', quote?.reasons?.length ? quote.reasons : [(e as Error).message]);
    }
    row = await this.prisma.dataQuery.update({ where: { id: row.id }, data: { buyerStakeId } });

    // ---- 4. Escrow the hold ----------------------------------------------------
    const escrow = await this.escrowAgent(a.slug);
    if (price.heldMinor > 0n) {
      try {
        const t = await this.wallet.send({ fromAgentId: buyerAgentId, toAgentId: escrow, amountMinor: price.heldMinor, currency: 'USD', idempotencyKey: `dataescrow:${row.id}` });
        row = await this.prisma.dataQuery.update({ where: { id: row.id }, data: { escrowTransferId: t.transferId } });
      } catch (e) {
        await this.dev.score.settle(buyerStakeId, { success: false, evidence: { queryId: row.id, reason: (e as Error).message } }).catch(() => undefined);
        return this.finish(row, 'REFUSED', [(e as Error).message]);
      }
    }

    // ---- 5. Ask the company ----------------------------------------------------
    const consent = subject ? this.consentDoc(subject, a, q, row) : undefined;
    const maxRows = maxRowsFor(q.pricing);
    let resp: { status: number; body: string; sigOk: boolean };
    try {
      resp = await this.call(a, {
        type: 'query', query_id: row.id, data_agent: a.slug, question_type: q.key, input: input.input, purpose: input.purpose,
        max_rows: maxRows, ...(subject ? { subject: subject.subject, consent } : {}),
      }, row.id);
    } catch (e) {
      return this.failAfterEscrow(row, a, 'FAILED', ['ENDPOINT_UNREACHABLE', String((e as Error).message).slice(0, 80)], { seller: false });
    }

    // ---- 6. Contract checks on the answer ------------------------------------
    if (!resp.sigOk) return this.failAfterEscrow(row, a, 'FAILED', ['ANSWER_SIGNATURE_INVALID'], { seller: false });
    let parsed: any;
    try { parsed = JSON.parse(resp.body); } catch { return this.failAfterEscrow(row, a, 'FAILED', ['ANSWER_NOT_JSON'], { seller: true, q }); }
    if (resp.status === 422 && parsed && typeof parsed.refused === 'string') {
      // The company declined (its own policy). Not a breach: refund, no seller penalty, buyer stake lost.
      return this.failAfterEscrow(row, a, 'REFUSED', ['SELLER_REFUSED', String(parsed.refused).slice(0, 80)], { seller: false });
    }
    if (resp.status !== 200) return this.failAfterEscrow(row, a, 'FAILED', [`ENDPOINT_STATUS_${resp.status}`], { seller: false });

    const breaches: string[] = [];
    const rows = parsed?.usage?.rows, ms = parsed?.usage?.compute_ms;
    if (!(Number.isInteger(rows) && rows >= 0) || !(Number.isInteger(ms) && ms >= 0)) breaches.push('USAGE_INVALID');
    if (maxRows !== null && Number.isInteger(rows) && rows > maxRows) breaches.push('ROWS_ABOVE_MAX');
    const asOf = typeof parsed?.as_of === 'string' || typeof parsed?.as_of === 'number' ? new Date(parsed.as_of) : null;
    const nowMs = this.now().getTime();
    if (!asOf || isNaN(asOf.getTime())) breaches.push('AS_OF_MISSING');
    else if (asOf.getTime() > nowMs + 60_000) breaches.push('AS_OF_IN_FUTURE');
    else if (nowMs - asOf.getTime() > q.freshnessSeconds * 1000) breaches.push('STALE_ANSWER');
    if (!('result' in (parsed ?? {}))) breaches.push('RESULT_MISSING');
    else {
      const outErrs = validate(q.outputSchema as JsonSchema, parsed.result);
      if (outErrs.length) breaches.push('OUTPUT_SCHEMA_VIOLATION');
      const priv = privacyViolations(parsed.result, q.privacy);
      breaches.push(...[...new Set(priv.map((v) => v.code))]);
    }
    if (breaches.length) return this.failAfterEscrow(row, a, 'REFUSED', breaches, { seller: true, q });

    // ---- 7. Meter -------------------------------------------------------------
    const priceGas = meter(q.pricing, { rows, computeMs: ms });
    const feeGas = this.feeFor(q, priceGas);
    const amountMinor = price.heldMinor === 0n ? 0n : this.gas.gasToMinorAt(priceGas + feeGas, price.priceMilli);
    const sellerMinor = BigInt(Math.floor((priceGas * price.priceMilli) / 1000));
    const feeMinor = amountMinor - sellerMinor;

    // ---- 8. Seller stakes Score on accuracy -----------------------------------
    let sellerStakeId: string;
    try {
      sellerStakeId = (await this.dev.score.commit({
        agentId: a.agentId, capability: 'data.answer', intentKey: `dataanswer:${row.id}`, confidencePct: Math.round(q.accuracyClaim * 100),
        amountMinor, currency: 'USD', ttlMs: a.disputeWindowMs + 86_400_000,
      })).stakeId;
    } catch (e) {
      const reasons = (e as { quote?: { reasons: string[] } }).quote?.reasons ?? [(e as Error).message];
      return this.failAfterEscrow(row, a, 'REFUSED', ['SELLER_CANNOT_STAKE', ...reasons], { seller: false, buyerWins: true });
    }

    // ---- 9. Record (only if still PENDING: recover() may have failed it meanwhile), refund the rest, receipt
    const refund = price.heldMinor - amountMinor;
    const resultSha256 = sha256hex(canon(parsed.result));
    const answeredAt = this.now();
    const receipt = this.receiptFor({
      kind: 'data_query_receipt', query_id: row.id, data_agent: a.slug, question_type: q.key, purpose: input.purpose, buyer_agent_id: buyerAgentId,
      price_gas: priceGas, fee_gas: feeGas, amount_minor: amountMinor.toString(), currency: 'USD', rows, compute_ms: ms, as_of: asOf!.toISOString(),
      result_sha256: resultSha256, accuracy_claim: q.accuracyClaim, freshness_seconds: q.freshnessSeconds, subject_verified: !!subject,
      dispute_until: new Date(answeredAt.getTime() + a.disputeWindowMs).toISOString(), iat: answeredAt.getTime(),
    });
    const claimed = await this.prisma.dataQuery.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: {
        status: 'ANSWERED', priceGas, feeGas, amountMinor, sellerMinor, feeMinor, rowsScanned: rows, computeMs: ms, asOf, resultSha256,
        receipt: receipt as unknown as Prisma.InputJsonValue, sellerStakeId, answeredAt,
      },
    });
    if (claimed.count !== 1) {
      // Too late: the query was already failed and refunded. Release the seller's stake without penalty.
      await this.dev.score.settle(sellerStakeId, { success: true, evidence: { queryId: row.id, voided: 'answered_after_timeout' } }).catch(() => undefined);
      return this.queryView(await this.prisma.dataQuery.findUniqueOrThrow({ where: { id: row.id } }), { replayed: false });
    }
    if (refund > 0n) {
      const t = await this.wallet.send({ fromAgentId: escrow, toAgentId: buyerAgentId, amountMinor: refund, currency: 'USD', idempotencyKey: `datarefund:${row.id}` });
      await this.prisma.dataQuery.update({ where: { id: row.id }, data: { refundTransferId: t.transferId } });
    }
    row = await this.prisma.dataQuery.findUniqueOrThrow({ where: { id: row.id } });
    await this.dev.score.settle(buyerStakeId, { success: true, evidence: { queryId: row.id, resultSha256 } }).catch(() => undefined);
    return { ...(await this.queryView(row, { replayed: false })), result: parsed.result };
  }

  /** Buyer's owner, within the dispute window: refunded in full, seller's accuracy stake lost. */
  async dispute(ownerId: string, queryId: string, reason: string) {
    const why = String(reason ?? '').trim();
    if (!why || why.length > 500) throw err('DISPUTE_REASON_REQUIRED');
    const q = await this.prisma.dataQuery.findUnique({ where: { id: queryId } });
    if (!q) throw err('QUERY_NOT_FOUND');
    const buyer = await this.prisma.agent.findUnique({ where: { id: q.buyerAgentId } });
    if (!buyer || buyer.ownerId !== ownerId) throw err('QUERY_NOT_FOUND');
    const a = await this.prisma.dataAgent.findUniqueOrThrow({ where: { id: q.dataAgentId } });
    // Claim the transition first, so a batch can never pay out a disputed query (and vice versa).
    const claimed = await this.prisma.dataQuery.updateMany({
      where: { id: q.id, status: 'ANSWERED', batchId: null, answeredAt: { gt: new Date(this.now().getTime() - a.disputeWindowMs) } },
      data: { status: 'DISPUTED', reason: `DISPUTED: ${why}` },
    });
    if (claimed.count !== 1) throw err(q.status === 'DISPUTED' ? 'ALREADY_DISPUTED' : q.status === 'ANSWERED' ? 'DISPUTE_WINDOW_CLOSED' : 'NOT_DISPUTABLE');
    if (q.amountMinor > 0n) {
      await this.wallet.send({ fromAgentId: await this.escrowAgent(a.slug), toAgentId: q.buyerAgentId, amountMinor: q.amountMinor, currency: 'USD', idempotencyKey: `datadispute:${q.id}` });
    }
    if (q.sellerStakeId) await this.dev.score.settle(q.sellerStakeId, { success: false, evidence: { queryId: q.id, disputed: why } }).catch(() => undefined);
    return this.queryView(await this.prisma.dataQuery.findUniqueOrThrow({ where: { id: q.id } }), { replayed: false });
  }

  async getQuery(agentId: string, queryId: string) {
    const q = await this.prisma.dataQuery.findUnique({ where: { id: queryId } });
    if (!q || q.buyerAgentId !== agentId) throw err('QUERY_NOT_FOUND');
    return this.queryView(q, { replayed: false });
  }

  async queriesForOwner(ownerId: string, limit = 50) {
    const agents = await this.prisma.agent.findMany({ where: { ownerId }, select: { id: true } });
    const rows = await this.prisma.dataQuery.findMany({ where: { buyerAgentId: { in: agents.map((a) => a.id) } }, orderBy: { createdAt: 'desc' }, take: Math.min(200, limit) });
    return Promise.all(rows.map((r) => this.queryView(r, { replayed: false })));
  }

  /**
   * Standing access with a monthly budget per company agent. Recurring by nature, so a
   * connection can only subscribe if its mandate has "allow recurring" switched on.
   */
  async subscribe(actor: { ownerId: string } | { connection: AgentConnection }, buyerAgentId: string, p: { dataAgent: string; monthlyBudgetMinor: bigint }) {
    const buyer = await this.prisma.agent.findUnique({ where: { id: buyerAgentId } });
    if (!buyer) throw err('AGENT_NOT_FOUND');
    if ('ownerId' in actor) { if (buyer.ownerId !== actor.ownerId) throw err('AGENT_NOT_OWNED'); }
    else {
      const c = actor.connection;
      if (c.agentId !== buyerAgentId) throw err('AGENT_NOT_OWNED');
      if (!c.allowRecurring) throw err('MANDATE_RECURRING_NOT_ALLOWED');
      if (!this.gasServiceAllowed(c, p.dataAgent)) throw err('MANDATE_SERVICE_NOT_ALLOWED');
    }
    const a = await this.prisma.dataAgent.findUnique({ where: { slug: p.dataAgent } });
    if (!a) throw err('DATA_AGENT_NOT_FOUND');
    if (!(typeof p.monthlyBudgetMinor === 'bigint' && p.monthlyBudgetMinor > 0n && p.monthlyBudgetMinor <= 10_000_000n)) throw err('INVALID_MONTHLY_BUDGET');
    const connectionId = 'connection' in actor ? actor.connection.id : null;
    return this.prisma.dataSubscription.upsert({
      where: { dataAgentId_buyerAgentId: { dataAgentId: a.id, buyerAgentId } },
      update: { monthlyBudgetMinor: p.monthlyBudgetMinor, status: 'ACTIVE', cancelledAt: null, connectionId },
      create: { dataAgentId: a.id, buyerAgentId, ownerId: buyer.ownerId, connectionId, monthlyBudgetMinor: p.monthlyBudgetMinor },
    }).then((s) => this.subscriptionView(s, a.slug));
  }

  async cancelSubscription(actor: { ownerId: string } | { connection: AgentConnection }, subscriptionId: string) {
    const s = await this.prisma.dataSubscription.findUnique({ where: { id: subscriptionId } });
    if (!s) throw err('SUBSCRIPTION_NOT_FOUND');
    if ('ownerId' in actor ? s.ownerId !== actor.ownerId : s.buyerAgentId !== actor.connection.agentId) throw err('SUBSCRIPTION_NOT_FOUND');
    const a = await this.prisma.dataAgent.findUniqueOrThrow({ where: { id: s.dataAgentId } });
    return this.subscriptionView(await this.prisma.dataSubscription.update({ where: { id: s.id }, data: { status: 'CANCELLED', cancelledAt: this.now() } }), a.slug);
  }

  async subscriptions(buyerAgentId: string) {
    const rows = await this.prisma.dataSubscription.findMany({ where: { buyerAgentId }, orderBy: { createdAt: 'desc' } });
    const agents = await this.prisma.dataAgent.findMany({ where: { id: { in: rows.map((r) => r.dataAgentId) } } });
    const slug = new Map(agents.map((a) => [a.id, a.slug]));
    return Promise.all(rows.map((r) => this.subscriptionView(r, slug.get(r.dataAgentId) ?? '')));
  }

  // =========================================================================
  // SETTLEMENT (batched) + recovery
  // =========================================================================

  /**
   * Pays out ANSWERED queries whose dispute window has closed, in batches per data agent:
   * PayPali fee → fee agent, ACTIVE splits by bps of the net → data sources, the rest → the company.
   * Crash-safe: queries are claimed into a batch with its payout plan first; every transfer is
   * idempotent on (batch, payee); a rerun finishes any batch whose queries are still ANSWERED.
   */
  async settleDue(): Promise<{ batches: number; queries: number }> {
    let batches = 0, queries = 0;
    // Finish interrupted batches first.
    const stuck = await this.prisma.dataQuery.findMany({ where: { status: 'ANSWERED', batchId: { not: null } }, distinct: ['batchId'], select: { batchId: true } });
    for (const s of stuck) { queries += await this.completeBatch(s.batchId!); batches++; }

    const agents = await this.prisma.dataAgent.findMany({ select: { id: true, disputeWindowMs: true } });
    for (const a of agents) {
      const cutoff = new Date(this.now().getTime() - a.disputeWindowMs);
      for (;;) {
        const batchId = await this.claimBatch(a.id, cutoff);
        if (!batchId) break;
        queries += await this.completeBatch(batchId);
        batches++;
      }
    }
    return { batches, queries };
  }

  /**
   * Demo/ops only: settle one data agent's answered queries now, closing their dispute windows early.
   * The server exposes it behind the admin token and never in production.
   */
  async settleEarly(slug: string) {
    const a = await this.prisma.dataAgent.findUnique({ where: { slug } });
    if (!a) throw err('DATA_AGENT_NOT_FOUND');
    let batches = 0, queries = 0, paidToCompanyMinor = 0n, feeMinor = 0n;
    for (;;) {
      const batchId = await this.claimBatch(a.id, new Date(Date.UTC(9999, 0, 1)));
      if (!batchId) break;
      queries += await this.completeBatch(batchId);
      batches++;
      const b = await this.prisma.dataSettlementBatch.findUniqueOrThrow({ where: { id: batchId } });
      feeMinor += b.feeMinor;
      for (const p of b.payouts as Array<{ agentId: string; minor: string }>) if (p.agentId === a.agentId) paidToCompanyMinor += BigInt(p.minor);
    }
    return { batches, queries, paidToCompanyMinor, feeMinor };
  }

  private async claimBatch(dataAgentId: string, cutoff: Date): Promise<string | null> {
    const feeAgent = await this.systemAgent('fees', 'PayPali data fees');   // outside the transaction (own connection)
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "DataAgent" WHERE id = ${dataAgentId} FOR UPDATE`;
      const due = await tx.dataQuery.findMany({ where: { dataAgentId, status: 'ANSWERED', batchId: null, answeredAt: { lte: cutoff } }, orderBy: { answeredAt: 'asc' }, take: this.cfg.batchSize });
      if (!due.length) return null;
      const a = await tx.dataAgent.findUniqueOrThrow({ where: { id: dataAgentId } });
      const gross = due.reduce((s, q) => s + q.amountMinor, 0n);
      const fee = due.reduce((s, q) => s + q.feeMinor, 0n);
      const net = gross - fee;
      const splits = await tx.dataSourceSplit.findMany({ where: { dataAgentId, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
      const payouts: Array<{ agentId: string; label: string; minor: string }> = [];
      if (fee > 0n) payouts.push({ agentId: feeAgent, label: 'PayPali fee', minor: fee.toString() });
      let paid = 0n;
      for (const s of splits) {
        const m = (net * BigInt(s.shareBps)) / 10_000n;
        if (m > 0n) { payouts.push({ agentId: s.payeeAgentId, label: s.label, minor: m.toString() }); paid += m; }
      }
      if (net - paid > 0n) payouts.push({ agentId: a.agentId, label: a.name, minor: (net - paid).toString() });
      const batch = await tx.dataSettlementBatch.create({ data: { dataAgentId, queryCount: due.length, grossMinor: gross, feeMinor: fee, payouts } });
      await tx.dataQuery.updateMany({ where: { id: { in: due.map((q) => q.id) }, status: 'ANSWERED', batchId: null }, data: { batchId: batch.id } });
      return batch.id;
    });
  }

  private async completeBatch(batchId: string): Promise<number> {
    const b = await this.prisma.dataSettlementBatch.findUniqueOrThrow({ where: { id: batchId } });
    const a = await this.prisma.dataAgent.findUniqueOrThrow({ where: { id: b.dataAgentId } });
    const escrow = await this.escrowAgent(a.slug);
    const plan = b.payouts as Array<{ agentId: string; label: string; minor: string; transferId?: string }>;
    for (const p of plan) {
      const t = await this.wallet.send({ fromAgentId: escrow, toAgentId: p.agentId, amountMinor: BigInt(p.minor), currency: 'USD', idempotencyKey: `databatch:${b.id}:${p.agentId}` });
      p.transferId = t.transferId;
    }
    await this.prisma.dataSettlementBatch.update({ where: { id: b.id }, data: { payouts: plan } });
    const qs = await this.prisma.dataQuery.findMany({ where: { batchId: b.id, status: 'ANSWERED' } });
    await this.prisma.dataQuery.updateMany({ where: { batchId: b.id, status: 'ANSWERED' }, data: { status: 'SETTLED' } });
    for (const q of qs) if (q.sellerStakeId) await this.dev.score.settle(q.sellerStakeId, { success: true, evidence: { queryId: q.id, batchId: b.id, undisputed: true } }).catch(() => undefined);
    return qs.length;
  }

  /** Fails PENDING queries left behind by a crash (or a hung endpoint) and refunds what was escrowed. */
  async recover(): Promise<number> {
    const stale = await this.prisma.dataQuery.findMany({ where: { status: 'PENDING', createdAt: { lt: new Date(this.now().getTime() - this.cfg.stuckAfterMs) } }, take: 200 });
    for (const q of stale) {
      const a = await this.prisma.dataAgent.findUniqueOrThrow({ where: { id: q.dataAgentId } });
      await this.failAfterEscrow(q, a, 'FAILED', ['TIMED_OUT'], { seller: false });
    }
    return stale.length;
  }

  // =========================================================================
  // STATS
  // =========================================================================

  async stats(dataAgentId: string) {
    const groups = await this.prisma.dataQuery.groupBy({ by: ['questionTypeId', 'status'], where: { dataAgentId }, _count: { _all: true } });
    const qts = await this.prisma.dataQuestionType.findMany({ where: { dataAgentId }, select: { id: true, key: true, accuracyClaim: true } });
    const per = new Map(qts.map((q) => [q.id, { key: q.key, claim: q.accuracyClaim, answered: 0, settled: 0, disputed: 0, refused: 0, failed: 0 }]));
    const tot = { answered: 0, settled: 0, disputed: 0, refused: 0, failed: 0 };
    for (const g of groups) {
      const k = g.status === 'ANSWERED' ? 'answered' : g.status === 'SETTLED' ? 'settled' : g.status === 'DISPUTED' ? 'disputed' : g.status === 'REFUSED' ? 'refused' : g.status === 'FAILED' ? 'failed' : null;
      if (!k) continue;
      tot[k] += g._count._all;
      const p = per.get(g.questionTypeId);
      if (p) p[k] += g._count._all;
    }
    const acc = (x: { answered: number; settled: number; disputed: number }) => {
      const n = x.answered + x.settled + x.disputed;
      return n ? (x.answered + x.settled) / n : null;
    };
    return {
      ...tot, observedAccuracy: acc(tot),
      questionTypes: [...per.values()].map((p) => ({ key: p.key, accuracyClaim: p.claim, observedAccuracy: acc(p), delivered: p.answered + p.settled + p.disputed, disputed: p.disputed, breaches: p.refused })),
    };
  }

  // =========================================================================
  // internals
  // =========================================================================

  private async failAfterEscrow(row: DataQuery, a: DataAgent, status: 'FAILED' | 'REFUSED', reasons: string[], who: { seller: boolean; q?: QT; buyerWins?: boolean }): Promise<QueryResult> {
    // Claim the terminal state first (PENDING → status): only one path refunds.
    const claimed = await this.prisma.dataQuery.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status, reason: reasons.join(',').slice(0, 300) } });
    const fresh = await this.prisma.dataQuery.findUniqueOrThrow({ where: { id: row.id } });
    if (claimed.count !== 1) return this.queryView(fresh, { replayed: true });
    let refundTransferId: string | null = null;
    const escrowed = fresh.escrowTransferId ?? (await this.prisma.agentTransfer.findUnique({ where: { idempotencyKey: `dataescrow:${row.id}` } }))?.id;
    if (escrowed && fresh.heldMinor > 0n) {
      refundTransferId = (await this.wallet.send({ fromAgentId: await this.escrowAgent(a.slug), toAgentId: row.buyerAgentId, amountMinor: fresh.heldMinor, currency: 'USD', idempotencyKey: `datarefund:${row.id}` })).transferId;
    }
    if (fresh.buyerStakeId) await this.dev.score.settle(fresh.buyerStakeId, { success: !!who.buyerWins, evidence: { queryId: row.id, reasons } }).catch(() => undefined);
    let sellerStakeId: string | null = null;
    if (who.seller && who.q) {
      // Contract breach: the seller commits a stake at its claimed accuracy and loses it.
      try {
        sellerStakeId = (await this.dev.score.commit({
          agentId: a.agentId, capability: 'data.answer', intentKey: `databreach:${row.id}`, confidencePct: Math.round(who.q.accuracyClaim * 100),
          amountMinor: fresh.heldMinor, currency: 'USD', ttlMs: 3_600_000,
        })).stakeId;
        await this.dev.score.settle(sellerStakeId, { success: false, evidence: { queryId: row.id, breach: reasons } });
      } catch { /* a seller that cannot even stake is already gated out of answering */ }
    }
    const done = await this.prisma.dataQuery.update({ where: { id: row.id }, data: { refundTransferId, ...(sellerStakeId ? { sellerStakeId } : {}) } });
    return this.queryView(done, { replayed: false });
  }

  private async finish(row: DataQuery, status: 'REFUSED' | 'FAILED', reasons: string[]): Promise<QueryResult> {
    const done = await this.prisma.dataQuery.update({ where: { id: row.id }, data: { status, reason: reasons.join(',').slice(0, 300) } });
    return this.queryView(done, { replayed: false });
  }

  private async call(a: DataAgent, payload: Record<string, unknown>, queryId: string) {
    const secret = openSecret(a.endpointSecret);
    const body = JSON.stringify(payload);
    const ts = String(this.now().getTime());
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.endpointTimeoutMs);
    try {
      const r = await this.fetchFn(a.endpointUrl, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-paypali-data-ts': ts, 'x-paypali-data-signature': signData(secret, ts, body), 'user-agent': 'PayPali-DataAgents/1' },
        body,
      });
      const text = await r.text();
      if (Buffer.byteLength(text) > this.cfg.maxResultBytes) throw new Error('ANSWER_TOO_LARGE');
      return { status: r.status, body: text, sigOk: sigEq(r.headers.get('x-data-agent-signature'), signData(secret, queryId, text)) };
    } finally { clearTimeout(timer); }
  }

  private consentDoc(s: { subject: string; method: string; notAfter?: number }, a: DataAgent, q: QT, row: DataQuery) {
    const iat = this.now().getTime();
    return this.identity.issuer!.sign({
      kind: 'data_subject_consent', issuer: this.identity.issuer!.id, subject: s.subject, assurance: 'kyc', method: s.method,
      data_agent: a.slug, question_type: q.key, query_id: row.id, purpose: SELF_ACCESS, iat, exp: Math.min(iat + 10 * 60_000, s.notAfter ?? Infinity),
    });
  }

  private receiptFor(body: Record<string, unknown>) {
    const iss = this.identity.issuer;
    return iss ? iss.sign({ ...body, kind: 'data_query_receipt', issuer: iss.id }) : { body, sig: null };
  }

  private priceFor(q: QT) {
    const maxFee = this.feeFor(q, q.pricing.maxGas);
    const total = q.pricing.maxGas + maxFee;
    const priceMilli = this.gas.priceMilli;   // locked for this query: hold and metering use the same Gas price
    return { maxFee, priceMilli, heldMinor: total > 0 ? this.gas.gasToMinorAt(total, priceMilli) : 0n };
  }

  /** Same fee rule as Gas services; waived for self-queries (your own data is a right, not a product). */
  private feeFor(q: QT, priceGas: number) {
    if (q.subjectQuery || priceGas === 0) return 0;
    return Math.max(this.gas.cfg.minFeeGas, Math.ceil((priceGas * this.gas.cfg.feeBps) / 10_000));
  }

  private purposeOk(q: QT, purpose: string) {
    return PURPOSE.test(purpose) && (q.allowedPurposes.length === 0 || q.allowedPurposes.includes(purpose));
  }

  private gasServiceAllowed(c: AgentConnection, slug: string) {
    const id = dataServiceId(slug);
    return c.allowedServices.includes('*') || c.allowedServices.includes(id) || c.allowedServices.includes('data:*');
  }

  private async monthSpend(db: Prisma.TransactionClient | PrismaClient, subscriptionId: string): Promise<bigint> {
    const n = this.now();
    const since = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
    const [held, done] = await Promise.all([
      db.dataQuery.aggregate({ _sum: { heldMinor: true }, where: { subscriptionId, createdAt: { gte: since }, status: 'PENDING' } }),
      db.dataQuery.aggregate({ _sum: { amountMinor: true }, where: { subscriptionId, createdAt: { gte: since }, status: { in: ['ANSWERED', 'SETTLED'] } } }),
    ]);
    return (held._sum.heldMinor ?? 0n) + (done._sum.amountMinor ?? 0n);
  }

  private async resolve(slug: string, key: string) {
    const a = await this.prisma.dataAgent.findUnique({ where: { slug: String(slug ?? '') } });
    if (!a) throw err('DATA_AGENT_NOT_FOUND');
    const q = await this.prisma.dataQuestionType.findUnique({ where: { dataAgentId_key: { dataAgentId: a.id, key: String(key ?? '') } } });
    if (!q || !q.active) throw err('QUESTION_TYPE_NOT_FOUND');
    return { a, q: asQT(q) };
  }

  private async owned(ownerId: string, dataAgentId: string) {
    const a = await this.prisma.dataAgent.findUnique({ where: { id: dataAgentId } });
    if (!a || a.ownerId !== ownerId) throw err('DATA_AGENT_NOT_FOUND');
    return a;
  }

  private async buyerOwner(agentId: string) {
    const b = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!b) throw err('AGENT_NOT_FOUND');
    return b.ownerId;
  }

  private async requireKyc(ownerId: string, code: string) {
    const g = this.identity.kyc ? await this.identity.kyc.grantFor(ownerId).catch(() => null) : null;
    if (!g || g.assurance !== 'kyc') throw err(code);
  }

  private checkEndpoint(url: string) {
    let u: URL;
    try { u = new URL(String(url)); } catch { throw err('INVALID_ENDPOINT_URL'); }
    if (u.username || u.password) throw err('INVALID_ENDPOINT_URL');
    if (u.protocol !== 'https:' && !(this.cfg.allowInsecureEndpoints && u.protocol === 'http:')) throw err('ENDPOINT_MUST_BE_HTTPS');
  }

  async escrowAgent(slug: string) { return this.systemAgent(`escrow-${slug}`, `Data escrow: ${slug}`); }

  private async systemAgent(key: string, name: string): Promise<string> {
    const cached = this.systemAgents.get(key);
    if (cached) return cached;
    const email = `data+${key}@paypali.system`;
    const owner = await this.prisma.owner.upsert({ where: { email }, update: {}, create: { email } });
    const agent = (await this.prisma.agent.findFirst({ where: { ownerId: owner.id, name } })) ?? (await this.prisma.agent.create({ data: { ownerId: owner.id, name } }));
    this.systemAgents.set(key, agent.id);
    return agent.id;
  }

  // ---- views ---------------------------------------------------------------

  agentView(a: DataAgent) {
    return { id: a.id, slug: a.slug, name: a.name, description: a.description, agentId: a.agentId, status: a.status, disputeWindowHours: Math.round(a.disputeWindowMs / HOUR), createdAt: a.createdAt };
  }

  private contractView(q: QT, a: Pick<DataAgent, 'disputeWindowMs'>) {
    return {
      freshnessSeconds: q.freshnessSeconds, accuracyClaim: q.accuracyClaim, privacy: q.privacy, allowedPurposes: q.allowedPurposes,
      subjectQuery: q.subjectQuery, disputeWindowHours: Math.round(a.disputeWindowMs / HOUR),
    };
  }

  questionView(q: QT, owner = false) {
    const p = q.pricing;
    return {
      key: q.key, title: q.title, description: q.description, inputSchema: q.inputSchema, outputSchema: q.outputSchema,
      pricing: { ...(p as Pricing), feeWaived: q.subjectQuery },
      freshnessSeconds: q.freshnessSeconds, accuracyClaim: q.accuracyClaim, privacy: q.privacy, allowedPurposes: q.allowedPurposes,
      subjectQuery: q.subjectQuery, ...(owner ? { active: q.active, updatedAt: q.updatedAt } : {}),
    };
  }

  private subscriptionView(s: { id: string; dataAgentId: string; buyerAgentId: string; connectionId: string | null; monthlyBudgetMinor: bigint; status: string; createdAt: Date; cancelledAt: Date | null }, slug: string) {
    return this.monthSpend(this.prisma, s.id).then((spent) => ({
      id: s.id, dataAgent: slug, buyerAgentId: s.buyerAgentId, viaConnection: s.connectionId, monthlyBudgetMinor: s.monthlyBudgetMinor,
      spentThisMonthMinor: spent, status: s.status, createdAt: s.createdAt, cancelledAt: s.cancelledAt,
    }));
  }

  private async queryView(q: DataQuery, o: { replayed: boolean }): Promise<QueryResult> {
    const [a, qt] = await Promise.all([this.prisma.dataAgent.findUnique({ where: { id: q.dataAgentId } }), this.prisma.dataQuestionType.findUnique({ where: { id: q.questionTypeId } })]);
    return {
      queryId: q.id, status: q.status, reasons: q.reason ? q.reason.split(',') : [], dataAgent: a?.slug ?? '', questionType: qt?.key ?? '',
      gas: { price: q.priceGas, fee: q.feeGas, max: q.maxGas }, heldMinor: q.heldMinor, amountMinor: q.amountMinor,
      usage: q.rowsScanned != null ? { rows: q.rowsScanned, computeMs: q.computeMs ?? 0 } : undefined, asOf: q.asOf,
      receipt: (q.receipt as QueryResult['receipt']) ?? null,
      disputeUntil: q.answeredAt && a ? new Date(q.answeredAt.getTime() + a.disputeWindowMs) : null,
      replayed: o.replayed,
    };
  }
}
