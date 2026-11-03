import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { AgentWalletService } from '../src/services/AgentWalletService';
import { AgentDevService } from '../src/agentdev/AgentDevService';
import { AgentConnectService } from '../src/connect/AgentConnectService';
import { GasService } from '../src/market/GasService';
import { createConnectRoutes } from '../src/connect/httpRoutes';
import { BazaarBridge } from '../src/bazaar/BazaarBridge';
import { PROVIDERS, findSurface, isPublicUrl, providerFromClientName, setupFor } from '../src/connect/providers';
import { PLATFORMS } from '../src/market/directory';
import { createTestDb, TestDb } from './harness';

let db: TestDb, prisma: PrismaClient, dev: AgentDevService, connect: AgentConnectService;

beforeEach(async () => {
  db = await createTestDb();
  prisma = db.prisma;
  const wallet = new AgentWalletService(prisma);
  dev = new AgentDevService(prisma, wallet);
  connect = new AgentConnectService(prisma, dev);
});
afterEach(async () => db.close());

async function ownerWithPolicy() {
  const o = await prisma.owner.create({ data: { email: `o_${randomUUID()}@example.com` } });
  const a = await prisma.agent.create({ data: { ownerId: o.id, name: 'Claude agent' } });
  await prisma.policy.create({ data: { ownerId: o.id, currency: 'USD', maxPerTransactionMinor: 1_500n, maxDailyBudgetMinor: 4_000n, maxMonthlyBudgetMinor: 20_000n, requireHumanApprovalAbove: 1_000n, allowedRecipients: [], allowedCategories: [] } });
  return { ownerId: o.id, agentId: a.id, email: o.email };
}

describe('Bring an agent you already use', () => {
  it('covers the major assistants, each with at least one way in, and app surfaces sign in with OAuth', () => {
    for (const id of ['claude', 'chatgpt', 'grok', 'gemini', 'deepseek', 'perplexity', 'mistral', 'copilot', 'cursor', 'muse']) {
      const p = PROVIDERS.find((x) => x.id === id)!;
      expect(p, id).toBeTruthy();
      expect(p.surfaces.length).toBeGreaterThan(0);
      expect(PLATFORMS.some((pl) => pl.providerId === id)).toBe(true);
    }
    for (const p of PROVIDERS) for (const s of p.surfaces) {
      expect(['app', 'developer', 'api']).toContain(s.kind);
      if (s.kind === 'app') { expect(s.auth).toBe('oauth'); expect(s.needsPublicUrl).toBe(true); expect(s.steps?.length).toBeGreaterThan(2); }
      else expect(s.auth).toBe('bearer');
    }
    expect(providerFromClientName('DeepSeek host')).toBe('deepseek');
    expect(providerFromClientName('Le Chat')).toBe('mistral');
    const ds = setupFor('deepseek', 'https://pp.example/mcp', 'ppk_x').find((s) => s.surface === 'deepseek-agents-sdk')!;
    expect(ds.setup).toContain('https://api.deepseek.com');
    expect(ds.setup).toContain('Bearer ppk_x');
    expect(setupFor('claude', 'https://pp.example/mcp')[0].steps![1]).toBe('Paste this URL: https://pp.example/mcp');
  });

  it('knows which URLs a vendor cloud can reach', () => {
    expect(isPublicUrl('https://paypali.example.com')).toBe(true);
    for (const u of ['http://paypali.example.com', 'https://localhost:4000', 'http://localhost:4000', 'https://127.0.0.1', 'https://192.168.1.4', 'https://box.local']) expect(isPublicUrl(u), u).toBe(false);
  });

  it('token surfaces get a connection with limits taken from the owner’s spending policy', async () => {
    const o = await ownerWithPolicy();
    const r = await connect.connectExisting(o.ownerId, o.agentId, { surface: 'deepseek-agents-sdk', scopes: ['context:read', 'wallet:read', 'gas:pay', 'data:query'], allowRecurring: true });
    expect(r.mode).toBe('token');
    expect(r.token).toMatch(/^ppk_/);
    expect(r.connection).toMatchObject({ provider: 'deepseek', label: 'DeepSeek models in your own agent (OpenAI Agents SDK)', maxPerTxMinor: 1_500n, maxDailyMinor: 4_000n, approvalAboveMinor: 1_000n, allowRecurring: true });
    expect(r.connection!.scopes).toEqual(expect.arrayContaining(['gas:pay', 'gas:quote', 'data:query']));
    const ctx = await connect.authenticate(r.token!);
    expect(ctx.agentId).toBe(o.agentId);
    expect((await dev.skills.capabilitiesFor(o.agentId)).map((c) => c.capability)).toEqual(expect.arrayContaining(['market.service', 'data.query']));
  });

  it('app surfaces create nothing up front: the app signs in through PayPali’s OAuth consent', async () => {
    const o = await ownerWithPolicy();
    const r = await connect.connectExisting(o.ownerId, o.agentId, { surface: 'grok-app' });
    expect(r).toMatchObject({ mode: 'oauth', provider: 'grok', connection: null, token: null });
    expect(await prisma.agentConnection.count()).toBe(0);
    await expect(connect.connectExisting(o.ownerId, o.agentId, { surface: 'nope' })).rejects.toThrow('UNKNOWN_SURFACE');
    expect(findSurface('lechat-app')!.provider.id).toBe('mistral');
  });
});

describe('OAuth consent needs the signed-in owner (no email-only sign-in outside dev)', () => {
  let server: Server, base: string, session: { id: string; email: string } | null;
  beforeEach(async () => {
    const wallet = new AgentWalletService(prisma);
    const bazaar = {
      heldPurchases: async (ownerId: string) => ({ held: [{ ownerId }] }),
      approve: async (ownerId: string, orderId: string, input: { confidencePct?: number }) => ({
        ownerId, orderId, confidencePct: input.confidencePct, status: 'PAID',
      }),
      reject: async (ownerId: string, orderId: string, reason?: string) => ({
        ownerId, orderId, reason, status: 'FAILED',
      }),
    } as unknown as BazaarBridge;
    const routes = createConnectRoutes({
      prisma, connect, dev, wallet, gas: new GasService(prisma, wallet, dev.score), bazaar, publicUrl: 'http://pp.test', allowedOrigins: [],
      sessionOwner: async () => session, devEmailConsent: false,
    });
    server = createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url!, 'http://pp.test')))) { res.writeHead(404); res.end(); } });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it('asks a signed-out visitor to sign in, ignores login_email, and lists agents once signed in', async () => {
    const o = await ownerWithPolicy();
    const client = await connect.registerClient({ client_name: 'Grok', redirect_uris: ['https://grok.example/cb'] });
    const q = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://grok.example/cb', response_type: 'code', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 's', resource: 'http://pp.test/mcp', login_email: o.email });
    session = null;
    const anon = await (await fetch(`${base}/oauth/authorize?${q}`)).text();
    expect(anon).toContain('Sign in to PayPali');
    expect(anon).toContain('/login?next=%2Foauth%2Fauthorize');
    expect(anon).not.toContain('Claude agent');                     // typing someone's email shows nothing
    const post = await fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...Object.fromEntries(q), decision: 'approve', agent_id: o.agentId, max_per_tx: '5', max_daily: '10', services_all: 'on' }) });
    expect(post.status).toBe(400);
    expect(await post.text()).toContain('SIGN_IN_REQUIRED');
    session = { id: o.ownerId, email: o.email };
    const signed = await (await fetch(`${base}/oauth/authorize?${q}`)).text();
    expect(signed).toContain('Claude agent');
    expect(signed).toContain(`Signed in to PayPali as ${o.email}`);
  });

  it('serves and mutates the Bazaar owner inbox only for the signed-in owner', async () => {
    session = null;
    const anonymous = await fetch(`${base}/api/bazaar/approvals`);
    expect(anonymous.status).toBe(401);

    session = { id: 'owner_session_1', email: 'owner@example.com' };
    const listed = await fetch(`${base}/api/bazaar/approvals`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ held: [{ ownerId: session.id }] });

    const approved = await fetch(`${base}/api/bazaar/approvals/order-1/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confidencePct: 82 }),
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      ownerId: session.id, orderId: 'order-1', confidencePct: 82, status: 'PAID',
    });

    const rejected = await fetch(`${base}/api/bazaar/approvals/order-2/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Owner declined' }),
    });
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({
      rejected: true,
      order: { ownerId: session.id, orderId: 'order-2', reason: 'Owner declined' },
    });
  });
});
