import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { AgentWalletService } from '../src/services/AgentWalletService';
import { AgentDevService } from '../src/agentdev/AgentDevService';
import { AgentConnectService } from '../src/connect/AgentConnectService';
import { GasService } from '../src/market/GasService';
import { makePortalRegistry } from '../src/market/portals';
import { IdentityIssuer } from '../src/bazaar/IdentityIssuer';
import { KycService } from '../src/bazaar/KycService';
import { SandboxKycProvider } from '../src/bazaar/kycProviders';
import { canon, sha256hex } from '../src/bazaar/keys';
import { DataAgentService, DataFetch, signData } from '../src/data/DataAgentService';
import { meter, parsePricing, parseQuestionType, privacyViolations } from '../src/data/contract';
import { allowedServicesFrom, validateSelections } from '../src/market/directory';
import { createTestDb, TestDb } from './harness';

const USD = 'USD';
const HOUR = 3_600_000;
let db: TestDb, prisma: PrismaClient, wallet: AgentWalletService, dev: AgentDevService, gas: GasService;
let connect: AgentConnectService, issuer: IdentityIssuer, kyc: KycService, data: DataAgentService;
let clock: number;

// ---------------------------------------------------------------------------
// A fake company endpoint: verifies PayPali's signature, answers per question type.
// ---------------------------------------------------------------------------
type Handler = (req: any) => { status?: number; body: unknown; badSig?: boolean } | Promise<{ status?: number; body: unknown; badSig?: boolean }>;
const endpoint = {
  secret: '',
  seen: [] as any[],
  handlers: {} as Record<string, Handler>,
  reachable: true,
};
const fakeFetch: DataFetch = async (_url, init) => {
  if (!endpoint.reachable) throw new Error('ECONNREFUSED');
  const ts = init.headers['x-paypali-data-ts'];
  if (init.headers['x-paypali-data-signature'] !== signData(endpoint.secret, ts, init.body)) {
    const text = JSON.stringify({ error: 'bad signature' });
    return { status: 401, headers: { get: () => null }, text: async () => text };
  }
  const req = JSON.parse(init.body);
  endpoint.seen.push(req);
  let out: { status?: number; body: unknown; badSig?: boolean };
  if (req.type === 'challenge') out = { body: { challenge: req.challenge } };
  else out = await (endpoint.handlers[req.question_type] ?? (() => ({ status: 404, body: { error: 'unknown' } })))(req);
  const text = JSON.stringify(out.body);
  const sig = signData(out.badSig ? 'wrong-secret' : endpoint.secret, req.query_id, text);
  return { status: out.status ?? 200, headers: { get: (k: string) => (k === 'x-data-agent-signature' ? sig : null) }, text: async () => text };
};
const answer = (result: unknown, rows = 10, ms = 5, asOf = new Date(clock).toISOString()) => ({ body: { result, usage: { rows, compute_ms: ms }, as_of: asOf } });

beforeEach(async () => {
  db = await createTestDb();
  prisma = db.prisma;
  clock = Date.UTC(2026, 10, 3, 12, 0, 0);
  const now = () => new Date(clock);
  wallet = new AgentWalletService(prisma);
  dev = new AgentDevService(prisma, wallet, {}, now);
  gas = new GasService(prisma, wallet, dev.score, makePortalRegistry({ sandbox: true }), undefined, now);
  connect = new AgentConnectService(prisma, dev);
  issuer = IdentityIssuer.generate('paypali', () => clock).issuer;
  kyc = new KycService(prisma, issuer, new SandboxKycProvider('http://paypali.test'), { fingerprintKey: randomBytes(32), now });
  data = new DataAgentService(prisma, dev, wallet, gas, fakeFetch, { kyc, issuer }, {}, now);
  endpoint.secret = ''; endpoint.seen = []; endpoint.handlers = {}; endpoint.reachable = true;
});
afterEach(async () => db.close());

async function agent(name = 'agent', fund = 100_000n) {
  const o = await prisma.owner.create({ data: { email: `o_${randomUUID()}@example.com` } });
  const a = await prisma.agent.create({ data: { ownerId: o.id, name } });
  if (fund > 0n) await wallet.receive({ agentId: a.id, amountMinor: fund, currency: USD, idempotencyKey: randomUUID() });
  return { ownerId: o.id, agentId: a.id };
}

const LANES = {
  key: 'lane_volume', title: 'Shipments per lane', description: 'Weekly shipment counts by lane',
  inputSchema: { type: 'object', properties: { week: { type: 'string' } }, required: ['week'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { lanes: { type: 'array', items: { type: 'object', properties: { lane: { type: 'string' }, shipments: { type: 'integer' } }, required: ['lane', 'shipments'] } } }, required: ['lanes'] },
  pricing: { model: 'metered', baseGas: 20, perRowGas: 0.05, perComputeMsGas: 0.01, maxGas: 500 },
  freshnessSeconds: 3600, accuracyClaim: 0.9,
  privacy: { bannedFields: ['email', 'customer_name'], minAggregation: { field: 'shipments', min: 5, rowsPath: 'lanes' } },
  allowedPurposes: ['analytics', 'planning'],
};
const STATUS = {
  key: 'shipment_status', title: 'Shipment status', inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
  outputSchema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
  pricing: { model: 'fixed', baseGas: 40 }, freshnessSeconds: 300, accuracyClaim: 0.95, privacy: { bannedFields: ['email'] },
};
const MINE = {
  key: 'my_shipments', title: 'My shipments', inputSchema: { type: 'object', properties: {} },
  outputSchema: { type: 'object', properties: { shipments: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' } } } } } },
  pricing: { model: 'fixed', baseGas: 10 }, freshnessSeconds: 600, accuracyClaim: 0.97, subjectQuery: true,
};

async function company(opts: { questionTypes?: any[] } = {}) {
  const c = await agent('Acme Freight data agent', 200_000n);
  const r = await data.register(c.ownerId, { agentId: c.agentId, slug: 'acme-freight', name: 'Acme Freight', endpointUrl: 'https://data.acme.example/paypali' });
  endpoint.secret = r.endpointSecret;
  await data.verifyEndpoint(c.ownerId, r.dataAgent.id);
  for (const q of opts.questionTypes ?? [LANES, STATUS, MINE]) await data.upsertQuestionType(c.ownerId, r.dataAgent.id, q as any);
  return { ...c, dataAgentId: r.dataAgent.id };
}
async function buyer(capability = true) {
  const b = await agent('buyer');
  await dev.score.open(b.agentId);
  if (capability) await dev.skills.grantCapability(b.ownerId, b.agentId, 'data.query', 'HIGH');
  return b;
}
const lanes = (n: number[]) => ({ lanes: n.map((x, i) => ({ lane: `L${i}`, shipments: x })) });
const ask = (b: { agentId: string }, extra: Partial<Parameters<DataAgentService['query']>[1]> = {}, conn?: any) =>
  data.query(b.agentId, { dataAgent: 'acme-freight', questionType: 'lane_volume', input: { week: '2026-W44' }, purpose: 'analytics', confidencePct: 80, ...extra }, conn);
const escrowBalance = async () => wallet.getBalance(await data.escrowAgent('acme-freight'), USD);

// ===========================================================================
describe('Contracts per question type', () => {
  it('pricing: fixed or metered by rows / compute, capped by maxGas', () => {
    const p = parsePricing(LANES.pricing);
    expect(meter(p, { rows: 2000, computeMs: 100 })).toBe(121);    // 20 + 100 + 1
    expect(meter(p, { rows: 1_000_000, computeMs: 0 })).toBe(500);  // ceiling
    expect(meter(parsePricing({ model: 'fixed', baseGas: 40 }), { rows: 9e9, computeMs: 9e9 })).toBe(40);
    expect(() => parsePricing({ model: 'metered', baseGas: 10, maxGas: 100 })).toThrow('METERED_PRICING_NEEDS_A_RATE');
    expect(() => parsePricing({ model: 'metered', baseGas: 10, perRowGas: 1, maxGas: 5 })).toThrow('INVALID_PRICING_MAX');
  });

  it('rejects contracts that could leak or overcharge', () => {
    expect(() => parseQuestionType({ ...LANES, outputSchema: { type: 'object', properties: { Email: { type: 'string' } } } } as any)).toThrow('OUTPUT_SCHEMA_DECLARES_BANNED_FIELD:Email');
    expect(() => parseQuestionType({ ...LANES, accuracyClaim: 1 } as any)).toThrow('INVALID_ACCURACY_CLAIM');
    expect(() => parseQuestionType({ ...LANES, freshnessSeconds: 0 } as any)).toThrow('INVALID_FRESHNESS');
    expect(() => parseQuestionType({ ...MINE, pricing: { model: 'fixed', baseGas: 500 } } as any)).toThrow('SUBJECT_QUERY_MUST_BE_AT_COST');
    expect(() => parseQuestionType({ ...MINE, privacy: { minAggregation: { field: 'n', min: 5 } } } as any)).toThrow('SUBJECT_QUERY_CANNOT_AGGREGATE');
    expect(() => parseQuestionType({ ...LANES, allowedPurposes: ['self_access'] } as any)).toThrow('SELF_ACCESS_IS_FOR_SUBJECT_QUERIES');
    expect(() => parseQuestionType({ ...LANES, inputSchema: { type: 'object', pattern: '.*' } } as any)).toThrow('INVALID_INPUT_SCHEMA:unsupported_keyword:pattern');
    expect(parseQuestionType(MINE as any).allowedPurposes).toEqual(['self_access']);
  });

  it('privacy rules: banned fields anywhere (case/punctuation-insensitive), aggregation floor per group', () => {
    const rules = { bannedFields: ['customer_name'], minAggregation: { field: 'shipments', min: 5, rowsPath: 'lanes' } };
    expect(privacyViolations(lanes([5, 9]), rules)).toEqual([]);
    expect(privacyViolations({ lanes: [{ lane: 'A', shipments: 7, meta: [{ CustomerName: 'x' }] }] }, rules).map((v) => v.code)).toEqual(['BANNED_FIELD']);
    expect(privacyViolations(lanes([5, 2]), rules)).toEqual([{ code: 'AGGREGATION_BELOW_MINIMUM', at: '$.lanes[1].shipments' }]);
    expect(privacyViolations({ lanes: [{ lane: 'A' }] }, rules).map((v) => v.code)).toEqual(['AGGREGATION_SIZE_MISSING']);
    expect(privacyViolations({ other: [] }, rules).map((v) => v.code)).toEqual(['AGGREGATION_GROUPS_MISSING']);
  });
});

// ===========================================================================
describe('Data agent listing', () => {
  it('registers PAUSED with a one-time secret (stored sealed), goes ACTIVE only after a signed challenge', async () => {
    const c = await agent('co', 10_000n);
    await expect(data.register(c.ownerId, { agentId: c.agentId, slug: 'acme', name: 'Acme', endpointUrl: 'http://data.acme.example' })).rejects.toThrow('ENDPOINT_MUST_BE_HTTPS');
    const other = await agent('x', 0n);
    await expect(data.register(other.ownerId, { agentId: c.agentId, slug: 'acme', name: 'Acme', endpointUrl: 'https://a.example' })).rejects.toThrow('AGENT_NOT_OWNED');
    const r = await data.register(c.ownerId, { agentId: c.agentId, slug: 'acme', name: 'Acme', endpointUrl: 'https://a.example' });
    expect(r.dataAgent.status).toBe('PAUSED');
    const row = await prisma.dataAgent.findUniqueOrThrow({ where: { id: r.dataAgent.id } });
    expect(row.endpointSecret).not.toContain(r.endpointSecret);
    expect(await data.list()).toEqual([]);                                  // not listed until verified
    endpoint.secret = 'not-the-secret';
    await expect(data.verifyEndpoint(c.ownerId, r.dataAgent.id)).rejects.toThrow('ENDPOINT_VERIFICATION_FAILED');
    endpoint.secret = r.endpointSecret;
    expect((await data.verifyEndpoint(c.ownerId, r.dataAgent.id)).status).toBe('ACTIVE');
    await expect(data.register(c.ownerId, { agentId: c.agentId, slug: 'acme', name: 'Again', endpointUrl: 'https://a.example' })).rejects.toThrow('SLUG_TAKEN');
    // The seller stakes on accuracy: Score account + data.answer capability.
    expect((await dev.skills.capabilitiesFor(c.agentId)).map((x) => x.capability)).toContain('data.answer');
  });

  it('lists question types with their own prices, claims, privacy rules and allowed purposes', async () => {
    await company();
    const [l] = await data.list();
    expect(l).toMatchObject({ slug: 'acme-freight', serviceId: 'data:acme-freight', sellerAssurance: 'dev' });
    const byKey = Object.fromEntries(l.questionTypes.map((q: any) => [q.key, q]));
    expect(byKey.lane_volume).toMatchObject({ pricing: { model: 'metered', baseGas: 20, maxGas: 500, feeWaived: false }, freshnessSeconds: 3600, accuracyClaim: 0.9, allowedPurposes: ['analytics', 'planning'] });
    expect(byKey.shipment_status.pricing).toMatchObject({ model: 'fixed', baseGas: 40, maxGas: 40 });
    expect(byKey.my_shipments).toMatchObject({ subjectQuery: true, allowedPurposes: ['self_access'], pricing: { feeWaived: true } });
    expect(await data.list({ query: 'per lane' })).toHaveLength(1);
    expect(await data.list({ query: 'groceries' })).toHaveLength(0);
  });
});

// ===========================================================================
describe('Per-query metering, escrow and receipts', () => {
  it('holds the ceiling, meters rows + compute, refunds the rest, signs a receipt with the result hash', async () => {
    await company();
    const b = await buyer();
    const result = lanes([12, 30]);
    endpoint.handlers.lane_volume = () => answer(result, 2000, 100);
    const q0 = await data.quote(b.agentId, { dataAgent: 'acme-freight', questionType: 'lane_volume', purpose: 'analytics' });
    expect(q0).toMatchObject({ payable: true, maxRows: 9600, gas: { max: 500, maxFee: 10 } });
    expect(q0.heldMinor).toBe(gas.gasToMinor(510));

    const before = await wallet.getBalance(b.agentId, USD);
    const r = await ask(b, { idempotencyKey: 'week-44' });
    expect(r.status).toBe('ANSWERED');
    expect(r.result).toEqual(result);
    expect(r.gas).toMatchObject({ price: 121, fee: 10 });                       // fee = max(10, ceil(121 × 1.5%))
    expect(r.amountMinor).toBe(gas.gasToMinor(131));
    expect(await escrowBalance()).toBe(r.amountMinor);                        // unused hold refunded
    expect(await wallet.getBalance(b.agentId, USD)).toBeLessThanOrEqual(before - r.amountMinor);

    // What the company received: purpose travels with the query; max_rows from the price ceiling.
    expect(endpoint.seen.at(-1)).toMatchObject({ type: 'query', data_agent: 'acme-freight', question_type: 'lane_volume', purpose: 'analytics', max_rows: 9600, input: { week: '2026-W44' } });
    expect(endpoint.seen.at(-1).subject).toBeUndefined();

    // Receipt: PayPali-signed, carries purpose, price and the result hash; the result itself is not stored.
    expect(issuer.verifyOwn(r.receipt as any)).toBe(true);
    expect((r.receipt as any).body).toMatchObject({ kind: 'data_query_receipt', purpose: 'analytics', price_gas: 121, fee_gas: 10, rows: 2000, result_sha256: sha256hex(canon(result)) });
    expect(JSON.stringify(await prisma.dataQuery.findMany(), (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain('"L0"');

    // Both stakes: buyer's settled WON, seller's OPEN at its accuracy claim until the window closes.
    const row = await prisma.dataQuery.findUniqueOrThrow({ where: { id: r.queryId } });
    expect((await prisma.scoreStake.findUniqueOrThrow({ where: { id: row.buyerStakeId! } })).status).toBe('WON');
    const seller = await prisma.scoreStake.findUniqueOrThrow({ where: { id: row.sellerStakeId! } });
    expect(seller).toMatchObject({ status: 'OPEN', capability: 'data.answer', confidencePct: 90 });

    // Replay: same answer, no second charge, no second call.
    const calls = endpoint.seen.length;
    const again = await ask(b, { idempotencyKey: 'week-44' });
    expect(again).toMatchObject({ queryId: r.queryId, replayed: true, status: 'ANSWERED' });
    expect(endpoint.seen.length).toBe(calls);
    expect(await escrowBalance()).toBe(r.amountMinor);
  });

  it('refuses before any money moves: purpose, input schema, missing capability, paused agent', async () => {
    const c = await company();
    const b = await buyer();
    expect((await ask(b, { purpose: 'marketing' })).reasons).toContain('PURPOSE_NOT_ALLOWED');
    expect((await ask(b, { purpose: '' })).reasons).toContain('PURPOSE_REQUIRED');
    expect((await ask(b, { input: { week: 44 } })).reasons).toContain('INPUT_INVALID');
    const noCap = await buyer(false);
    endpoint.handlers.lane_volume = () => answer(lanes([10]));
    const r = await ask(noCap);
    expect(r).toMatchObject({ status: 'REFUSED', reasons: ['CAPABILITY_NOT_GRANTED'] });
    await data.update(c.ownerId, c.dataAgentId, { paused: true });
    expect((await ask(b)).reasons).toContain('DATA_AGENT_PAUSED');
    expect(endpoint.seen.filter((x) => x.type === 'query')).toHaveLength(0);
    expect(await escrowBalance()).toBe(0n);
  });
});

// ===========================================================================
describe('Answers that break the contract', () => {
  const cases: Array<[string, Handler, string]> = [
    ['banned field', () => answer({ lanes: [{ lane: 'A', shipments: 9, email: 'x@y.z' }] }), 'BANNED_FIELD'],
    ['aggregation below the floor', () => answer(lanes([9, 3])), 'AGGREGATION_BELOW_MINIMUM'],
    ['stale', () => answer(lanes([9]), 10, 5, new Date(clock - 2 * HOUR).toISOString()), 'STALE_ANSWER'],
    ['schema', () => answer({ rows: [] }), 'OUTPUT_SCHEMA_VIOLATION'],
    ['usage', () => ({ body: { result: lanes([9]), as_of: new Date(clock).toISOString() } }), 'USAGE_INVALID'],
  ];
  for (const [name, h, code] of cases) {
    it(`${name}: refused, fully refunded, seller's accuracy stake lost`, async () => {
      const c = await company();
      const b = await buyer();
      endpoint.handlers.lane_volume = h;
      const pointsBefore = (await dev.score.getAccount(c.agentId))!.balance;
      const r = await ask(b);
      expect(r.status).toBe('REFUSED');
      expect(r.reasons).toContain(code);
      expect(r.result).toBeUndefined();
      expect(await escrowBalance()).toBe(0n);
      const row = await prisma.dataQuery.findUniqueOrThrow({ where: { id: r.queryId } });
      expect((await prisma.scoreStake.findUniqueOrThrow({ where: { id: row.sellerStakeId! } })).status).toBe('LOST');
      expect((await dev.score.getAccount(c.agentId))!.balance).toBeLessThan(pointsBefore);
    });
  }

  it('a company refusal (422) or an unreachable / unsigned endpoint refunds without penalising the seller', async () => {
    const c = await company();
    const b = await buyer();
    endpoint.handlers.lane_volume = () => ({ status: 422, body: { refused: 'week not closed yet' } });
    const r1 = await ask(b);
    expect(r1).toMatchObject({ status: 'REFUSED', reasons: ['SELLER_REFUSED', 'week not closed yet'] });
    endpoint.handlers.lane_volume = () => ({ ...answer(lanes([9])), badSig: true });
    expect((await ask(b)).reasons).toEqual(['ANSWER_SIGNATURE_INVALID']);
    endpoint.reachable = false;
    expect((await ask(b)).status).toBe('FAILED');
    expect(await escrowBalance()).toBe(0n);
    const qs = await prisma.dataQuery.findMany();
    expect(qs.every((q) => q.sellerStakeId === null)).toBe(true);
    expect((await dev.score.getAccount(c.agentId))!.balance).toBe(dev.score.cfg.initialPoints);
  });

  it('a seller that cannot stake on its answer cannot sell it', async () => {
    const c = await company();
    await dev.skills.revokeCapability(c.ownerId, c.agentId, 'data.answer');
    const b = await buyer();
    endpoint.handlers.lane_volume = () => answer(lanes([9]));
    const r = await ask(b);
    expect(r.status).toBe('REFUSED');
    expect(r.reasons.slice(0, 2)).toEqual(['SELLER_CANNOT_STAKE', 'CAPABILITY_NOT_GRANTED']);
    expect(r.result).toBeUndefined();
    expect(await escrowBalance()).toBe(0n);
  });
});

// ===========================================================================
describe('Mandates, allow recurring and monthly budgets', () => {
  const m = (o: any = {}) => ({ maxPerTxMinor: 5_000n, maxDailyMinor: 20_000n, approvalAboveMinor: null, ...o });

  it('a connection may only query data agents its mandate names (data:<slug> or data:*)', async () => {
    await company();
    const b = await buyer();
    endpoint.handlers.lane_volume = () => answer(lanes([9]));
    const { connection: narrow } = await connect.createConnection(b.ownerId, b.agentId, { provider: 'claude', scopes: ['data:query'], mandate: m({ allowedServices: ['netflix'] }) });
    expect((await ask(b, {}, narrow)).reasons).toContain('MANDATE_SERVICE_NOT_ALLOWED');
    const { connection: all } = await connect.createConnection(b.ownerId, b.agentId, { provider: 'claude', scopes: ['data:query'], mandate: m({ allowedServices: ['data:*'] }) });
    expect((await ask(b, {}, all)).status).toBe('ANSWERED');
    const { connection: tiny } = await connect.createConnection(b.ownerId, b.agentId, { provider: 'claude', scopes: ['data:query'], mandate: m({ maxPerTxMinor: 10n, maxDailyMinor: 10n, allowedServices: ['data:acme-freight'] }) });
    expect((await ask(b, {}, tiny)).reasons).toContain('MANDATE_PER_TX_LIMIT');
    // Spend counts toward the rolling 24h mandate total.
    expect(await gas.spentLast24h(all.id)).toBeGreaterThan(0n);
  });

  it('subscriptions are recurring: a connection needs "allow recurring"; the monthly budget caps spend per company agent', async () => {
    await company();
    const b = await buyer();
    endpoint.handlers.shipment_status = () => answer({ status: 'in transit' });
    const { connection: off } = await connect.createConnection(b.ownerId, b.agentId, { provider: 'claude', scopes: ['data:query'], mandate: m({ allowedServices: ['data:acme-freight'] }) });
    await expect(data.subscribe({ connection: off }, b.agentId, { dataAgent: 'acme-freight', monthlyBudgetMinor: 10n })).rejects.toThrow('MANDATE_RECURRING_NOT_ALLOWED');
    const on = await connect.updateMandate(b.ownerId, off.id, { allowRecurring: true });
    const sub = await data.subscribe({ connection: on }, b.agentId, { dataAgent: 'acme-freight', monthlyBudgetMinor: 12n });   // 12¢ ≈ two status checks at 5¢ (40 + 10 fee Gas)
    expect(sub).toMatchObject({ status: 'ACTIVE', monthlyBudgetMinor: 12n, spentThisMonthMinor: 0n });
    const status = (key: string) => data.query(b.agentId, { dataAgent: 'acme-freight', questionType: 'shipment_status', input: { ref: 'S1' }, purpose: 'tracking', confidencePct: 80, idempotencyKey: key }, on);
    expect((await status('a')).status).toBe('ANSWERED');
    expect((await status('b')).status).toBe('ANSWERED');
    expect((await status('c')).reasons).toContain('SUBSCRIPTION_BUDGET_EXCEEDED');
    // Switching recurring off again stops subscription spend through that connection.
    const off2 = await connect.updateMandate(b.ownerId, off.id, { allowRecurring: false });
    expect((await status('d')).reasons).toContain('MANDATE_RECURRING_NOT_ALLOWED');
    // A new month resets the budget.
    clock = Date.UTC(2026, 11, 1, 0, 0, 1);
    expect((await data.subscriptions(b.agentId))[0].spentThisMonthMinor).toBe(0n);
    await data.cancelSubscription({ ownerId: b.ownerId }, sub.id);
    expect((await data.query(b.agentId, { dataAgent: 'acme-freight', questionType: 'shipment_status', input: { ref: 'S1' }, purpose: 'tracking', confidencePct: 80 }, off2)).status).toBe('ANSWERED');
  });

  it('marketplace selections of kind "data" become data:<slug> in the mandate', () => {
    const items = validateSelections([{ kind: 'data', id: 'acme-freight' }, { kind: 'service', id: 'walmart' }]);
    expect(allowedServicesFrom(items)).toEqual(['walmart', 'data:acme-freight']);
    expect(() => validateSelections([{ kind: 'data', id: '../x' }])).toThrow('BAD_DATA_AGENT');
  });
});

// ===========================================================================
describe('Self-query consent (the asker is the data subject)', () => {
  it('needs a kyc identity; the company gets an issuer-signed consent naming the subject; at cost, no fee', async () => {
    await company();
    const b = await buyer();
    endpoint.handlers.my_shipments = (req) => answer({ shipments: [{ ref: `S-${req.subject.slice(0, 6)}` }] }, 3, 1);
    const self = () => data.query(b.agentId, { dataAgent: 'acme-freight', questionType: 'my_shipments', input: {}, purpose: 'self_access', confidencePct: 90 });
    expect((await data.quote(b.agentId, { dataAgent: 'acme-freight', questionType: 'my_shipments' })).blockers).toContain('SUBJECT_KYC_REQUIRED');
    expect((await self()).reasons).toContain('SUBJECT_KYC_REQUIRED');
    expect((await data.query(b.agentId, { dataAgent: 'acme-freight', questionType: 'my_shipments', input: {}, purpose: 'analytics', confidencePct: 90 })).reasons).toContain('PURPOSE_NOT_ALLOWED');

    const s: any = await kyc.start(b.ownerId);
    await kyc.complete(String(s.url).split('/').pop()!, { outcome: 'approve', payerId: 'PAYER123' });
    const r = await self();
    expect(r.status).toBe('ANSWERED');
    expect(r.gas).toMatchObject({ price: 10, fee: 0 });
    const req = endpoint.seen.at(-1);
    const person = await prisma.kycPerson.findUniqueOrThrow({ where: { ownerId: b.ownerId } });
    expect(req.subject).toBe(issuer.personSubject(person.id));
    expect(issuer.verifyOwn(req.consent)).toBe(true);
    expect(req.consent.body).toMatchObject({ kind: 'data_subject_consent', subject: req.subject, assurance: 'kyc', data_agent: 'acme-freight', question_type: 'my_shipments', query_id: r.queryId, purpose: 'self_access' });
    expect(req.consent.body.exp - req.consent.body.iat).toBeLessThanOrEqual(10 * 60_000);
    expect((r.receipt as any).body.subject_verified).toBe(true);
  });
});

// ===========================================================================
describe('Disputes, batched settlement and revenue splits', () => {
  it('a dispute inside the window refunds the buyer and the seller loses its stake; after it, the window is closed', async () => {
    await company();
    const b = await buyer();
    endpoint.handlers.shipment_status = () => answer({ status: 'delivered' });
    const q = (k: string) => data.query(b.agentId, { dataAgent: 'acme-freight', questionType: 'shipment_status', input: { ref: k }, purpose: 'tracking', confidencePct: 80 });
    const r1 = await q('S1'), r2 = await q('S2');
    const other = await agent('stranger', 0n);
    await expect(data.dispute(other.ownerId, r1.queryId, 'no')).rejects.toThrow('QUERY_NOT_FOUND');
    await expect(data.dispute(b.ownerId, r1.queryId, '')).rejects.toThrow('DISPUTE_REASON_REQUIRED');
    const d = await data.dispute(b.ownerId, r1.queryId, 'It was not delivered');
    expect(d.status).toBe('DISPUTED');
    expect(await escrowBalance()).toBe(r2.amountMinor);
    const row = await prisma.dataQuery.findUniqueOrThrow({ where: { id: r1.queryId } });
    expect((await prisma.scoreStake.findUniqueOrThrow({ where: { id: row.sellerStakeId! } })).status).toBe('LOST');
    await expect(data.dispute(b.ownerId, r1.queryId, 'again')).rejects.toThrow('ALREADY_DISPUTED');
    clock += 25 * HOUR;
    await expect(data.dispute(b.ownerId, r2.queryId, 'late')).rejects.toThrow('DISPUTE_WINDOW_CLOSED');
    const st = await data.stats((await prisma.dataAgent.findFirstOrThrow()).id);
    expect(st).toMatchObject({ answered: 1, disputed: 1, observedAccuracy: 0.5 });
  });

  it('settles in batches after the window: fee → PayPali, accepted splits → data sources, rest → company; resumes after a crash', async () => {
    const c = await company();
    const b = await buyer();
    const src = await agent('Port authority feed', 0n);
    endpoint.handlers.shipment_status = () => answer({ status: 'in transit' });

    // Splits: proposed by the company, paid only once the source's owner accepts; never over 100%.
    const split = await data.proposeSplit(c.ownerId, c.dataAgentId, { payeeAgentId: src.agentId, label: 'Port feed', shareBps: 2_500 });
    expect(split.status).toBe('PENDING');
    const third = await agent('other source', 0n);
    await expect(data.proposeSplit(c.ownerId, c.dataAgentId, { payeeAgentId: third.agentId, label: 'x', shareBps: 7_501 })).rejects.toThrow('SPLITS_EXCEED_100_PERCENT');
    await expect(data.proposeSplit(c.ownerId, c.dataAgentId, { payeeAgentId: c.agentId, label: 'me', shareBps: 10 })).rejects.toThrow('SPLIT_TO_SELF');
    await expect(data.acceptSplit(c.ownerId, split.id)).rejects.toThrow('SPLIT_NOT_FOUND');   // only the payee's owner accepts
    await data.acceptSplit(src.ownerId, split.id);

    const answers = [];
    for (let i = 0; i < 4; i++) answers.push(await data.query(b.agentId, { dataAgent: 'acme-freight', questionType: 'shipment_status', input: { ref: `S${i}` }, purpose: 'tracking', confidencePct: 80 }));
    const gross = answers.reduce((s, a) => s + a.amountMinor, 0n);
    const seller = answers.reduce((s, a) => s + 0n * a.amountMinor, 0n) + (await prisma.dataQuery.aggregate({ _sum: { sellerMinor: true } }))._sum.sellerMinor!;
    const fee = gross - seller;
    expect(await data.settleDue()).toEqual({ batches: 0, queries: 0 });          // still inside the window

    clock += 25 * HOUR;
    // Crash after claiming the batch (plan written, nothing paid) …
    const batchId = await (data as any).claimBatch(c.dataAgentId, new Date(clock - 24 * HOUR));
    expect(batchId).toBeTruthy();
    const companyBefore = await wallet.getBalance(c.agentId, USD);
    // … the next run finishes it.
    expect(await data.settleDue()).toEqual({ batches: 1, queries: 4 });
    expect(await escrowBalance()).toBe(0n);
    const share = (seller * 2_500n) / 10_000n;
    expect(await wallet.getBalance(src.agentId, USD)).toBe(share);
    const feesAgent = (await prisma.agent.findFirstOrThrow({ where: { name: 'PayPali data fees' } })).id;
    expect(await wallet.getBalance(feesAgent, USD)).toBe(fee);
    const qs = await prisma.dataQuery.findMany();
    expect(qs.every((q) => q.status === 'SETTLED' && q.batchId === batchId)).toBe(true);
    const stakes = await prisma.scoreStake.findMany({ where: { id: { in: qs.map((q) => q.sellerStakeId!) } } });
    expect(stakes.every((s) => s.status === 'WON')).toBe(true);
    // Company got the rest (its balance also moves with stake bonds being released, so check the transfer).
    const batch = await prisma.dataSettlementBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect((batch.payouts as any[]).find((p) => p.agentId === c.agentId).minor).toBe((seller - share).toString());
    expect(await wallet.getBalance(c.agentId, USD)).toBeGreaterThanOrEqual(companyBefore + (seller - share));
    expect(await data.settleDue()).toEqual({ batches: 0, queries: 0 });         // idempotent
    expect((await data.stats(c.dataAgentId)).settled).toBe(4);
  });

  it('recovers queries stuck PENDING after a crash: failed and refunded', async () => {
    await company();
    const b = await buyer();
    let release!: () => void;
    endpoint.handlers.lane_volume = () => new Promise((r) => { release = () => r(answer(lanes([9]))); });
    const pending = ask(b);
    await new Promise((r) => setTimeout(r, 300));
    const stuck = await prisma.dataQuery.findFirstOrThrow();
    expect(stuck.status).toBe('PENDING');
    expect(await escrowBalance()).toBe(stuck.heldMinor);
    clock += 10 * 60_000;
    expect(await data.recover()).toBe(1);
    expect(await escrowBalance()).toBe(0n);
    release();
    const late = await pending;                       // the late answer cannot resurrect a failed query
    expect(late.status).toBe('FAILED');
    expect(await escrowBalance()).toBe(0n);
  });
});
