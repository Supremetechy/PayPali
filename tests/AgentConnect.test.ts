import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AgentWalletService } from '../src/services/AgentWalletService';
import { AgentDevService } from '../src/agentdev/AgentDevService';
import { AgentConnectService } from '../src/connect/AgentConnectService';
import { handleMcpMessage } from '../src/connect/mcpServer';
import { GasService } from '../src/market/GasService';
import { makePortalRegistry } from '../src/market/portals';
import { createTestDb, TestDb } from './harness';

const USD = 'USD';
const MCP = 'http://localhost:4000/mcp';
let db: TestDb;
let prisma: PrismaClient;
let wallet: AgentWalletService;
let dev: AgentDevService;
let connect: AgentConnectService;
let gasLive: GasService;     // sandbox portals: full flow
let gasPlain: GasService;    // placeholder portals: production default

beforeEach(async () => {
  db = await createTestDb();
  prisma = db.prisma;
  wallet = new AgentWalletService(prisma);
  dev = new AgentDevService(prisma, wallet);
  connect = new AgentConnectService(prisma, dev);
  gasLive = new GasService(prisma, wallet, dev.score, makePortalRegistry({ sandbox: true }));
  gasPlain = new GasService(prisma, wallet, dev.score, makePortalRegistry());
});
afterEach(async () => db.close());

const mandate = (o: Partial<{ perTx: bigint; daily: bigint; approval: bigint | null; services: string[]; recurring: boolean }> = {}) => ({
  maxPerTxMinor: o.perTx ?? 5_000n, maxDailyMinor: o.daily ?? 10_000n, approvalAboveMinor: o.approval ?? null, allowedServices: o.services, allowRecurring: o.recurring,
});

async function agent(fund = 50_000n) {
  const owner = await prisma.owner.create({ data: { email: `o_${randomUUID()}@example.com` } });
  const a = await prisma.agent.create({ data: { ownerId: owner.id, name: 'shopper' } });
  if (fund > 0n) await wallet.receive({ agentId: a.id, amountMinor: fund, currency: USD, idempotencyKey: randomUUID() });
  return { ownerId: owner.id, agentId: a.id, email: owner.email };
}

async function connected(scopes = ['context:read', 'wallet:read', 'market:read', 'gas:quote', 'gas:pay'], m = mandate()) {
  const a = await agent();
  const { connection, token } = await connect.createConnection(a.ownerId, a.agentId, { provider: 'claude', scopes, mandate: m });
  return { ...a, connection, token: token! };
}

const rpc = (method: string, params?: Record<string, unknown>) => ({ jsonrpc: '2.0', id: 1, method, params });
const call = async (token: string, name: string, args: Record<string, unknown>, gas = gasLive) => {
  const ctx = await connect.authenticate(token);
  const r: any = await handleMcpMessage(ctx, rpc('tools/call', { name, arguments: args }), { dev, wallet, gas });
  return { isError: r.result?.isError, out: r.result?.structuredContent, raw: r };
};

describe('Gas marketplace', () => {
  it('prices fixed and metered actions in Gas with a network fee', async () => {
    const a = await agent();
    const fixed = await gasLive.estimate(a.agentId, { serviceId: 'netflix', actionId: 'subscribe_standard' });
    expect(fixed.gas).toMatchObject({ units: 18_000, fee: 270, total: 18_270 });   // 1.5% fee
    expect(fixed.amountMinor).toBe(1_827n);                                       // 18 270 Gas × $0.001
    const ride = await gasLive.estimate(a.agentId, { serviceId: 'uber', actionId: 'request_ride', params: { fare_minor: 2_350, pickup: 'A', dropoff: 'B' } });
    expect(ride.gas.units).toBe(23_500);
    await expect(gasLive.estimate(a.agentId, { serviceId: 'uber', actionId: 'request_ride', params: { pickup: 'A', dropoff: 'B' } })).rejects.toThrow('MISSING_PARAM:fare_minor');
    await expect(gasLive.estimate(a.agentId, { serviceId: 'uber', actionId: 'request_ride', params: { fare_minor: -5, pickup: 'A', dropoff: 'B' } })).rejects.toThrow('INVALID_PARAM:fare_minor');
  });

  it('placeholder portals refuse payment before any stake or money moves', async () => {
    const a = await agent();
    await dev.develop(a.ownerId, a.agentId);
    await dev.skills.grantCapability(a.ownerId, a.agentId, 'market.service', 'HIGH');
    const q = await gasPlain.estimate(a.agentId, { serviceId: 'netflix', actionId: 'subscribe_standard' });
    expect(q.payable).toBe(false);
    expect(q.blockers).toContain('PROVIDER_NOT_CONNECTED');
    const r = await gasPlain.pay(a.agentId, { quoteId: q.quoteId, confidencePct: 90 });
    expect(r.status).toBe('UNSUPPORTED');
    expect(await wallet.getBalance(a.agentId, USD)).toBe(50_000n);
    expect(await prisma.scoreStake.count()).toBe(0);
  });

  it('recurring actions need the mandate’s explicit "allow recurring" switch (off by default)', async () => {
    const off = await connected();
    expect(off.connection.allowRecurring).toBe(false);
    const q = await gasLive.estimate(off.agentId, { serviceId: 'spotify', actionId: 'subscribe_premium' }, off.connection);
    expect(q.blockers).toContain('MANDATE_RECURRING_NOT_ALLOWED');
    expect((await gasLive.pay(off.agentId, { quoteId: q.quoteId, confidencePct: 85 }, off.connection)).reasons).toContain('MANDATE_RECURRING_NOT_ALLOWED');
    // One-off actions are unaffected.
    const ride = await gasLive.estimate(off.agentId, { serviceId: 'uber', actionId: 'request_ride', params: { fare_minor: 900, pickup: 'A', dropoff: 'B' } }, off.connection);
    expect(ride.blockers).not.toContain('MANDATE_RECURRING_NOT_ALLOWED');
    // The owner flips the switch; the same subscription now passes.
    const on = await connect.updateMandate(off.ownerId, off.connection.id, { allowRecurring: true });
    expect(on.allowRecurring).toBe(true);
    const q2 = await gasLive.estimate(off.agentId, { serviceId: 'spotify', actionId: 'subscribe_premium' }, on);
    expect(q2.payable).toBe(true);
    await expect(connect.createConnection(off.ownerId, off.agentId, { provider: 'claude', mandate: { ...mandate(), allowRecurring: 'yes' as any } })).rejects.toThrow('INVALID_MANDATE_ALLOW_RECURRING');
  });

  it('sandbox: pays into escrow, fulfils, settles the Score stake WON; replay is idempotent', async () => {
    const c = await connected(undefined, mandate({ recurring: true }));
    const q = await gasLive.estimate(c.agentId, { serviceId: 'spotify', actionId: 'subscribe_premium' }, c.connection);
    const r = await gasLive.pay(c.agentId, { quoteId: q.quoteId, confidencePct: 85 }, c.connection);
    expect(r.status).toBe('FULFILLED');
    expect(r.sandbox).toBe(true);
    expect(r.settlement?.status).toBe('WON');
    expect(await wallet.getBalance(await gasLive.settlementAgent('spotify'), USD)).toBe(q.amountMinor);
    expect(await wallet.getBalance(c.agentId, USD)).toBe(50_000n - q.amountMinor);
    const again = await gasLive.pay(c.agentId, { quoteId: q.quoteId, confidencePct: 85 }, c.connection);
    expect(again.replayed).toBe(true);
    expect(await wallet.getBalance(c.agentId, USD)).toBe(50_000n - q.amountMinor);
  });

  it('a provider rejection refunds the Gas and settles the stake LOST', async () => {
    const c = await connected();
    const q = await gasLive.estimate(c.agentId, { serviceId: 'doordash', actionId: 'place_order', params: { subtotal_minor: 1_800, store_ref: 's1', sandbox_fail: true } }, c.connection);
    const r = await gasLive.pay(c.agentId, { quoteId: q.quoteId, confidencePct: 90 }, c.connection);
    expect(r.status).toBe('FAILED');
    expect(r.reasons).toContain('SANDBOX_PROVIDER_REJECTED');
    expect(r.settlement?.status).toBe('LOST');
    const lost = BigInt(-r.settlement!.delta) * dev.score.cfg.bondMinorPerPoint;
    expect(await wallet.getBalance(c.agentId, USD)).toBe(50_000n - lost);   // purchase refunded; only the forfeited bond is gone
  });

  it('enforces the connection mandate: services, per-payment, rolling 24h, approval', async () => {
    const c = await connected(undefined, mandate({ perTx: 2_000n, daily: 2_500n, approval: 1_500n, services: ['spotify', 'uber'] }));
    const ride = (fare: number) => gasLive.estimate(c.agentId, { serviceId: 'uber', actionId: 'request_ride', params: { fare_minor: fare, pickup: 'A', dropoff: 'B' } }, c.connection);
    const nf = await gasLive.estimate(c.agentId, { serviceId: 'netflix', actionId: 'subscribe_standard_ads' }, c.connection);
    expect(nf.blockers).toContain('MANDATE_SERVICE_NOT_ALLOWED');
    expect((await gasLive.pay(c.agentId, { quoteId: nf.quoteId, confidencePct: 80 }, c.connection)).reasons).toContain('MANDATE_SERVICE_NOT_ALLOWED');
    const big = await ride(2_500);
    expect((await gasLive.pay(c.agentId, { quoteId: big.quoteId, confidencePct: 80 }, c.connection)).reasons).toContain('MANDATE_PER_TX_LIMIT');
    const needsOk = await ride(1_600);
    expect(needsOk.needsApproval).toBe(true);
    expect((await gasLive.pay(c.agentId, { quoteId: needsOk.quoteId, confidencePct: 80 }, c.connection)).status).toBe('APPROVAL_REQUIRED');
    const ok1 = await ride(1_400);
    expect((await gasLive.pay(c.agentId, { quoteId: ok1.quoteId, confidencePct: 80, intentKey: 'ride-1' }, c.connection)).status).toBe('FULFILLED');
    const ok2 = await ride(1_400);
    expect((await gasLive.pay(c.agentId, { quoteId: ok2.quoteId, confidencePct: 80, intentKey: 'ride-2' }, c.connection)).reasons).toContain('MANDATE_DAILY_LIMIT');
  });

  it('data agents are valid mandate services: data:<slug> and data:*', async () => {
    const a = await agent();
    const { connection } = await connect.createConnection(a.ownerId, a.agentId, { provider: 'claude', scopes: ['data:query'], mandate: mandate({ services: ['data:acme-freight', 'data:*'] }) });
    expect(connection.allowedServices).toEqual(['data:acme-freight', 'data:*']);
    expect((await dev.skills.capabilitiesFor(a.agentId)).map((x) => x.capability)).toContain('data.query');
    await expect(connect.createConnection(a.ownerId, a.agentId, { provider: 'claude', mandate: mandate({ services: ['data:Bad Slug'] }) })).rejects.toThrow('UNKNOWN_SERVICE');
  });

  it('a quote made through one channel cannot be paid through another', async () => {
    const c = await connected();
    const q = await gasLive.estimate(c.agentId, { serviceId: 'spotify', actionId: 'subscribe_premium' }, c.connection);
    await expect(gasLive.pay(c.agentId, { quoteId: q.quoteId, confidencePct: 80 })).rejects.toThrow('QUOTE_NOT_FOUND');
  });
});

describe('Agent Connect: tokens, scopes, MCP tools', () => {
  it('approving gas:pay develops the agent and grants market.service', async () => {
    const c = await connected();
    expect(await dev.score.getAccount(c.agentId)).not.toBeNull();
    expect((await dev.skills.capabilitiesFor(c.agentId)).map((x) => x.capability)).toContain('market.service');
    expect(c.token).toMatch(/^ppk_/);
    const row = await prisma.connectionToken.findFirst({ where: { connectionId: c.connection.id } });
    expect(row!.tokenHash).not.toContain(c.token.slice(4, 20));   // only the hash is stored
  });

  it('lists only the tools the connection’s scopes allow, and re-checks at call time', async () => {
    const ro = await connected(['market:read']);
    const ctx = await connect.authenticate(ro.token);
    const list: any = await handleMcpMessage(ctx, rpc('tools/list'), { dev, wallet, gas: gasLive });
    expect(list.result.tools.map((t: any) => t.name).sort()).toEqual(['get_order', 'get_service', 'my_licenses', 'search_services', 'skill_quote', 'skills_search']);
    const denied = await call(ro.token, 'pay_with_gas', { quote_id: 'x', confidence_pct: 80 });
    expect(denied.isError).toBe(true);
    expect(denied.out.error).toBe('SCOPE_NOT_GRANTED');
  });

  it('runs a full purchase over MCP tool calls', async () => {
    const c = await connected();
    const ctxOut = (await call(c.token, 'get_agent_context', {})).out;
    expect(ctxOut.connection.provider).toBe('claude');
    expect(ctxOut.context.score.balance).toBe(1000);
    const found = (await call(c.token, 'search_services', { query: 'ride' })).out.services;
    expect(found.map((s: any) => s.id)).toEqual(['uber']);
    const est = (await call(c.token, 'estimate_gas', { service_id: 'uber', action_id: 'request_ride', params: { fare_minor: 1_900, pickup: 'Home', dropoff: 'Office' }, confidence_pct: 80 })).out;
    expect(est.payable).toBe(true);
    expect(est.score.allowed).toBe(true);
    const paid = await call(c.token, 'pay_with_gas', { quote_id: est.quoteId, confidence_pct: 80, intent_key: 'commute-oct-30' });
    expect(paid.isError).toBe(false);
    expect(paid.out.status).toBe('FULFILLED');
    const order = (await call(c.token, 'get_order', { order_id: paid.out.orderId })).out;
    expect(order.status).toBe('FULFILLED');
    const bal = (await call(c.token, 'get_balance', {})).out;
    expect(BigInt(bal.availableMinor)).toBe(50_000n - BigInt(est.amountMinor));
  });

  it('revoked or rotated tokens stop working immediately', async () => {
    const c = await connected();
    const { token: fresh } = await connect.rotateToken(c.ownerId, c.connection.id);
    await expect(connect.authenticate(c.token)).rejects.toThrow('INVALID_TOKEN');
    await connect.authenticate(fresh);
    await connect.revoke(c.ownerId, c.connection.id);
    await expect(connect.authenticate(fresh)).rejects.toThrow('INVALID_TOKEN');
  });

  it('validates mandates and providers', async () => {
    const a = await agent();
    await expect(connect.createConnection(a.ownerId, a.agentId, { provider: 'claude', mandate: mandate({ perTx: 5_000n, daily: 1_000n }) })).rejects.toThrow('MANDATE_DAILY_BELOW_PER_TX');
    await expect(connect.createConnection(a.ownerId, a.agentId, { provider: 'skynet', mandate: mandate() })).rejects.toThrow('UNKNOWN_PROVIDER');
    await expect(connect.createConnection(a.ownerId, a.agentId, { provider: 'claude', mandate: mandate({ services: ['blockbuster'] }) })).rejects.toThrow('UNKNOWN_SERVICE:blockbuster');
    const other = await agent();
    await expect(connect.createConnection(other.ownerId, a.agentId, { provider: 'claude', mandate: mandate() })).rejects.toThrow('AGENT_NOT_OWNED');
  });
});

describe('Agent Connect: OAuth 2.1', () => {
  const pkce = () => { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };

  async function authorize(a: { ownerId: string; agentId: string }) {
    const client = await connect.registerClient({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    const { verifier, challenge } = pkce();
    const q = { client_id: client.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', resource: MCP };
    const { redirect } = await connect.approve(a.ownerId, q, MCP, { agentId: a.agentId, provider: 'claude', scopes: ['context:read', 'gas:pay'], mandate: mandate() });
    const u = new URL(redirect);
    return { client, verifier, code: u.searchParams.get('code')!, state: u.searchParams.get('state') };
  }

  it('code + PKCE → access/refresh tokens that work on /mcp; refresh rotates', async () => {
    const a = await agent();
    const { client, verifier, code, state } = await authorize(a);
    expect(state).toBe('st8');
    const t = await connect.exchangeCode({ code, code_verifier: verifier, client_id: client.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback' });
    expect(t.token_type).toBe('Bearer');
    const ctx = await connect.authenticate(t.access_token);
    expect(ctx.scopes).toEqual(['context:read', 'gas:quote', 'gas:pay']);
    const t2 = await connect.refresh({ refresh_token: t.refresh_token, client_id: client.client_id });
    await connect.authenticate(t2.access_token);
    await expect(connect.authenticate(t.refresh_token)).rejects.toThrow('INVALID_TOKEN');   // refresh tokens never authenticate /mcp
  });

  it('rejects a wrong PKCE verifier, and a replayed code revokes the connection', async () => {
    const a = await agent();
    const first = await authorize(a);
    await expect(connect.exchangeCode({ code: first.code, code_verifier: 'x'.repeat(43), client_id: first.client.client_id })).rejects.toThrow('invalid_grant');
    const second = await authorize(a);
    const t = await connect.exchangeCode({ code: second.code, code_verifier: second.verifier, client_id: second.client.client_id });
    await expect(connect.exchangeCode({ code: second.code, code_verifier: second.verifier, client_id: second.client.client_id })).rejects.toThrow('invalid_grant');
    await expect(connect.authenticate(t.access_token)).rejects.toThrow();   // whole connection killed on replay
  });

  it('refresh-token reuse revokes the connection', async () => {
    const a = await agent();
    const { client, verifier, code } = await authorize(a);
    const t = await connect.exchangeCode({ code, code_verifier: verifier, client_id: client.client_id });
    const t2 = await connect.refresh({ refresh_token: t.refresh_token, client_id: client.client_id });
    await expect(connect.refresh({ refresh_token: t.refresh_token, client_id: client.client_id })).rejects.toThrow('invalid_grant');
    await expect(connect.authenticate(t2.access_token)).rejects.toThrow();
  });

  it('validates registration and authorize requests', async () => {
    await expect(connect.registerClient({ client_name: 'x', redirect_uris: ['http://evil.example/cb'] })).rejects.toThrow('invalid_redirect_uri');
    await expect(connect.registerClient({ client_name: 'x', redirect_uris: ['https://ok.example/cb#frag'] })).rejects.toThrow('invalid_redirect_uri');
    const local = await connect.registerClient({ client_name: 'Inspector', redirect_uris: ['http://localhost:6274/oauth/callback'] });
    const base = { client_id: local.client_id, redirect_uri: 'http://localhost:6274/oauth/callback', response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' };
    await expect(connect.checkAuthorizeRequest({ ...base, redirect_uri: 'http://localhost:6274/other' }, MCP)).rejects.toThrow('invalid_redirect_uri');
    await expect(connect.checkAuthorizeRequest({ ...base, code_challenge_method: 'plain' }, MCP)).rejects.toThrow('pkce_s256_required');
    await expect(connect.checkAuthorizeRequest({ ...base, resource: 'https://other.example/mcp' }, MCP)).rejects.toThrow('invalid_target');
    expect((await connect.checkAuthorizeRequest(base, MCP)).scopes).toContain('gas:pay');
  });
});
