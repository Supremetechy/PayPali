import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { AgentWalletService } from '../src/services/AgentWalletService';
import { AgentDevService } from '../src/agentdev/AgentDevService';
import { AgentConnectService } from '../src/connect/AgentConnectService';
import { handleMcpMessage } from '../src/connect/mcpServer';
import { MerchantService } from '../src/merchant/MerchantService';
import { GasService } from '../src/market/GasService';
import { makePortalRegistry } from '../src/market/portals';
import { BazaarBridge } from '../src/bazaar/BazaarBridge';
import { BazaarClient } from '../src/bazaar/BazaarClient';
import { IdentityIssuer } from '../src/bazaar/IdentityIssuer';
import { KycService } from '../src/bazaar/KycService';
import { SandboxKycProvider } from '../src/bazaar/kycProviders';
import { createTestDb, TestDb } from './harness';

// The real AgentBazaar server (CommonJS), started in-process on a random port.
const require = createRequire(import.meta.url);
const { start } = require('../AgentBazaar/server.js');
const { Identity, call: bzCall } = require('../AgentBazaar/client.js');
const { createVendorEndpoint } = require('../AgentBazaar/vendor-kit.js');

const USD = 'USD';
let db: TestDb, prisma: PrismaClient, wallet: AgentWalletService, dev: AgentDevService, merchants: MerchantService;
let gas: GasService, connect: AgentConnectService, bridge: BazaarBridge, bazaar: { server: any; url: string };

/** Bazaar payments adapter backed directly by MerchantService (same contract as AgentBazaar/paypali.js, minus HTTP). */
function inProcessPayments(ms: MerchantService) {
  const M = 'agentbazaar';
  const s = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
  return {
    provider: 'paypali',
    getGrant: async (id: string) => { try { return s(await ms.getGrant(M, id)); } catch { return null; } },
    charge: async (p: any) => {
      const r = await ms.charge(M, { grantId: p.grant_id, amountMinor: BigInt(p.amount_minor), currency: p.currency, idempotencyKey: p.idempotency_key, reference: p.reference, score: { intentKey: p.intent_key, confidencePct: p.confidence_pct } });
      return { status: r.status, charge_id: r.chargeId ?? null, stake_id: r.stakeId ?? null, reasons: r.reasons, score_quote: s(r.scoreQuote ?? null) };
    },
    reportOutcome: async (id: string, success: boolean, evidence: any) => s(await ms.reportOutcome(M, id, { success, evidence })),
    refund: async (id: string, reason: string) => s(await ms.refund(M, id, reason)),
    payout: async (p: any) => ({ payout_id: (await ms.payout(M, { toAgentId: p.to_agent_id, amountMinor: BigInt(p.amount_minor), currency: p.currency, idempotencyKey: p.idempotency_key, binding: p.binding })).payoutId }),
    verifyWebhook: () => false,
  };
}

beforeEach(async () => {
  db = await createTestDb();
  prisma = db.prisma;
  wallet = new AgentWalletService(prisma);
  dev = new AgentDevService(prisma, wallet);
  merchants = new MerchantService(prisma, wallet, dev.score, [{ id: 'agentbazaar', secret: 'test-secret-0123456789abcdef' }]);
  gas = new GasService(prisma, wallet, dev.score, makePortalRegistry({ sandbox: true }));
  connect = new AgentConnectService(prisma, dev);
  bazaar = await start(0, { payments: inProcessPayments(merchants), tickMs: 100 });
  bridge = new BazaarBridge(prisma, dev, merchants, gas, new BazaarClient(bazaar.url));
});
afterEach(async () => { bazaar.server.close(); await db.close(); });

async function agent(fund = 50_000n) {
  const owner = await prisma.owner.create({ data: { email: `o_${randomUUID()}@example.com` } });
  const a = await prisma.agent.create({ data: { ownerId: owner.id, name: 'buyer' } });
  if (fund > 0n) await wallet.receive({ agentId: a.id, amountMinor: fund, currency: USD, idempotencyKey: randomUUID() });
  return { ownerId: owner.id, agentId: a.id };
}
const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 6000): Promise<T> => {
  const t = Date.now();
  for (;;) { const v = await fn(); if (v) return v as T; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); }
};

describe('PayPali agents shop AgentBazaar', () => {
  it('owner enables → agent buys (verified receipt) → runs → reports → owner confirms → stake WON', async () => {
    const a = await agent();
    const acct = await bridge.enable(a.ownerId, a.agentId, { budgetMinor: 10_000n, capMinor: 5_000n });
    expect(acct.enabled).toBe(true);
    const found = await bridge.search({ query: 'fee' });
    expect(found.results[0].id).toBe('sf-0152');

    const r = await bridge.buy(a.agentId, { solutionId: 'sf-0152', confidencePct: 80 });
    expect(r.status).toBe('PAID');
    expect(r.receiptVerified).toBe(true);
    expect(r.chargeId).toBeTruthy();
    const bond = await wallet.getReserved(a.agentId, USD);
    expect(bond).toBeGreaterThan(0n);
    expect(await wallet.getBalance(a.agentId, USD)).toBe(50_000n - 2_800n - bond);

    const run = await bridge.run(a.agentId, r.receiptId!, { holdings: [{ value: 10_000, expense_ratio: 0.008 }] });
    expect(run.output.annual_fee_drag).toBe(80);
    await bridge.report(a.agentId, run.runId, true, 80);
    const pend = await bridge.pending(a.ownerId);
    expect(pend.pending.map((x: any) => x.run_id)).toContain(run.runId);
    await bridge.attest(a.ownerId, run.runId, 'confirm');

    const stake = await until(async () => { const s = await prisma.scoreStake.findUnique({ where: { id: r.stakeId! } }); return s?.status === 'WON' ? s : null; });
    expect(stake.delta).toBeGreaterThan(0);
    expect(await wallet.getReserved(a.agentId, USD)).toBe(0n);
    expect((await bridge.status(a.agentId)).orders[0].status).toBe('PAID');

    // Owner kill switch: the receipt's mandate is revoked and nothing re-enables it automatically.
    await bridge.disable(a.ownerId, a.agentId);
    await expect(bridge.buy(a.agentId, { solutionId: 'sf-0271', confidencePct: 80 })).rejects.toThrow('BAZAAR_DISABLED_BY_OWNER');
    await expect(bridge.run(a.agentId, r.receiptId!, {})).rejects.toThrow('BAZAAR_RUN_FAILED:mandate_revoked');
    expect((await bridge.enable(a.ownerId, a.agentId)).enabled).toBe(true);
  });

  it('a disputed purchase settles LOST and forfeits part of the bond', async () => {
    const a = await agent();
    await bridge.enable(a.ownerId, a.agentId);
    const r = await bridge.buy(a.agentId, { solutionId: 'sf-0201', confidencePct: 95 });
    const run = await bridge.run(a.agentId, r.receiptId!, {});
    await bridge.report(a.agentId, run.runId, true);
    await bridge.attest(a.ownerId, run.runId, 'dispute', 'clauses it flagged were fine');
    const stake = await until(async () => { const s = await prisma.scoreStake.findUnique({ where: { id: r.stakeId! } }); return s?.status === 'LOST' ? s : null; });
    expect(stake.delta).toBeLessThan(0);
    expect(await wallet.getBalance(a.agentId, USD)).toBe(50_000n - 4_800n - BigInt(-stake.delta!));
  });

  it('fails closed: not enabled, Bazaar on simulated credits, mandate cap, unknown solution', async () => {
    const a = await agent();
    await expect(bridge.buy(a.agentId, { solutionId: 'sf-0152', confidencePct: 80 })).rejects.toThrow('BAZAAR_NOT_ENABLED');
    const credits = await start(0, { payments: null });
    const offline = new BazaarBridge(prisma, dev, merchants, gas, new BazaarClient(credits.url));
    await expect(offline.enable(a.ownerId, a.agentId)).rejects.toThrow('BAZAAR_NOT_CONNECTED_TO_PAYPALI');
    credits.server.close();
    await bridge.enable(a.ownerId, a.agentId, { budgetMinor: 10_000n, capMinor: 3_000n });
    const tooBig = await bridge.buy(a.agentId, { solutionId: 'sf-0163', confidencePct: 80 });   // $55 > $30 cap
    expect(tooBig.status).toBe('DECLINED');
    expect(tooBig.reasons).toContain('over_per_purchase_cap');
    expect((await bridge.buy(a.agentId, { solutionId: 'sf-nope', confidencePct: 80 })).reasons).toEqual(['SOLUTION_NOT_FOUND']);
    const other = await agent();
    await expect(bridge.enable(other.ownerId, a.agentId)).rejects.toThrow('AGENT_NOT_OWNED');
  });

  it('the Score gate can refuse a purchase: nothing is charged', async () => {
    const a = await agent(2_810n);   // enough for the $28 price but not the bond on top
    await bridge.enable(a.ownerId, a.agentId);
    const r = await bridge.buy(a.agentId, { solutionId: 'sf-0152', confidencePct: 90 });
    expect(r.status).toBe('DECLINED');
    expect(r.reasons).toContain('INSUFFICIENT_FUNDS_FOR_BOND');
    expect(await wallet.getBalance(a.agentId, USD)).toBe(2_810n);
  });

  it('purchase policy: a preapproved category buys through and records the full context', async () => {
    const a = await agent();
    await bridge.enable(a.ownerId, a.agentId, { budgetMinor: 10_000n, capMinor: 5_000n });
    const r = await bridge.buy(a.agentId, {
      solutionId: 'sf-0152', confidencePct: 80,
      category: 'compute_model', trigger: 'nightly batch', beneficiary: 'owner', budgetOwner: a.ownerId, onFailure: 'retry once then report',
    });
    expect(r.status).toBe('PAID');
    const order = await prisma.bazaarOrder.findUnique({ where: { id: r.orderId! } });
    expect(order?.status).toBe('PAID');
    expect(order?.category).toBe('compute_model');
    expect(order?.permission).toBe('PREAPPROVED');
    expect(order?.trigger).toBe('nightly batch');
    expect(order?.budgetOwner).toBe(a.ownerId);
    expect(order?.onFailure).toBe('retry once then report');
    expect(order?.item).toBeTruthy();
  });

  it('purchase policy: a CONFIRM category holds for the owner and charges nothing until approved', async () => {
    const a = await agent();
    await bridge.enable(a.ownerId, a.agentId, { budgetMinor: 10_000n, capMinor: 5_000n });
    const held = await bridge.buy(a.agentId, { solutionId: 'sf-0152', confidencePct: 80, category: 'donations_contributions', beneficiary: 'Example Charity' });
    expect(held.status).toBe('APPROVAL_REQUIRED');
    const pending = await prisma.bazaarOrder.findUnique({ where: { id: held.orderId! } });
    expect(pending?.status).toBe('PENDING');
    expect(pending?.permission).toBe('CONFIRM');
    expect(pending?.chargeId).toBeNull();
    expect(pending?.beneficiary).toBe('Example Charity');
    expect(await wallet.getBalance(a.agentId, USD)).toBe(50_000n);          // nothing moved
    expect(await wallet.getReserved(a.agentId, USD)).toBe(0n);

    const approved = await bridge.buy(a.agentId, { solutionId: 'sf-0152', confidencePct: 80, category: 'donations_contributions', ownerApproved: true });
    expect(approved.status).toBe('PAID');
  });

  it('purchase policy: recurring forces CONFIRM even on a preapproved category', async () => {
    const a = await agent();
    await bridge.enable(a.ownerId, a.agentId, { budgetMinor: 10_000n, capMinor: 5_000n });
    const r = await bridge.buy(a.agentId, { solutionId: 'sf-0152', confidencePct: 80, category: 'compute_model', recurring: true });
    expect(r.status).toBe('APPROVAL_REQUIRED');
    expect(r.reasons).toContain('RECURRING_REQUIRES_APPROVAL');
  });

  it('purchase policy: an owner-prohibited category is declined and never charged', async () => {
    const a = await agent();
    await bridge.enable(a.ownerId, a.agentId, { budgetMinor: 10_000n, capMinor: 5_000n });
    await bridge.policy.setPolicy(a.ownerId, a.agentId, 'compute_model', { permission: 'PROHIBITED' });
    const r = await bridge.buy(a.agentId, { solutionId: 'sf-0152', confidencePct: 80, category: 'compute_model' });
    expect(r.status).toBe('DECLINED');
    expect(r.reasons).toContain('PURCHASE_PROHIBITED');
    const order = await prisma.bazaarOrder.findUnique({ where: { id: r.orderId! } });
    expect(order?.status).toBe('FAILED');
    expect(await wallet.getBalance(a.agentId, USD)).toBe(50_000n);
  });

  it('human approval: owner lists a held purchase, approves it, and the SAME order is charged once', async () => {
    const a = await agent();
    await bridge.enable(a.ownerId, a.agentId, { budgetMinor: 10_000n, capMinor: 5_000n });
    const held = await bridge.buy(a.agentId, { solutionId: 'sf-0152', confidencePct: 80, category: 'donations_contributions', beneficiary: 'Example Charity', trigger: 'user asked to donate' });
    expect(held.status).toBe('APPROVAL_REQUIRED');

    // The owner sees it in the approval queue with the context they need to judge it.
    const queue = await bridge.heldPurchases(a.ownerId);
    expect(queue.held.map((h: any) => h.orderId)).toContain(held.orderId);
    const item = queue.held.find((h: any) => h.orderId === held.orderId)!;
    expect(item.permission).toBe('CONFIRM');
    expect(item.beneficiary).toBe('Example Charity');
    expect(item.agentName).toBe('buyer');

    // Approve → the held order itself becomes PAID (no second order), and a HumanApproval is recorded.
    const approved = await bridge.approve(a.ownerId, held.orderId!, { confidencePct: 80 });
    expect(approved.status).toBe('PAID');
    expect(approved.orderId).toBe(held.orderId);
    const order = await prisma.bazaarOrder.findUnique({ where: { id: held.orderId! } });
    expect(order?.status).toBe('PAID');
    expect(order?.chargeId).toBeTruthy();
    expect(await prisma.humanApproval.count({ where: { ownerId: a.ownerId } })).toBe(1);
    expect(await prisma.bazaarOrder.count({ where: { agentId: a.agentId } })).toBe(1);   // reused, not duplicated

    // The queue is now empty, and approving again is refused.
    expect((await bridge.heldPurchases(a.ownerId)).held).toHaveLength(0);
    await expect(bridge.approve(a.ownerId, held.orderId!, {})).rejects.toThrow('NOT_AWAITING_APPROVAL');
  });

  it('human approval: owner can reject a held purchase; nothing is ever charged', async () => {
    const a = await agent();
    await bridge.enable(a.ownerId, a.agentId, { budgetMinor: 10_000n, capMinor: 5_000n });
    const held = await bridge.buy(a.agentId, { solutionId: 'sf-0152', confidencePct: 80, category: 'donations_contributions' });
    const rejected = await bridge.reject(a.ownerId, held.orderId!, 'not this one');
    expect(rejected.status).toBe('FAILED');
    expect(rejected.reasons).toContain('OWNER_REJECTED');
    expect(await wallet.getBalance(a.agentId, USD)).toBe(50_000n);
    expect((await bridge.heldPurchases(a.ownerId)).held).toHaveLength(0);
  });

  it('human approval: only the owning owner can approve, and never a settled order', async () => {
    const a = await agent();
    const other = await agent();
    await bridge.enable(a.ownerId, a.agentId, { budgetMinor: 10_000n, capMinor: 5_000n });
    const held = await bridge.buy(a.agentId, { solutionId: 'sf-0152', confidencePct: 80, category: 'donations_contributions' });
    await expect(bridge.approve(other.ownerId, held.orderId!, {})).rejects.toThrow('AGENT_NOT_OWNED');
    // A normal (preapproved) purchase is a settled PAID order, not an approvable hold.
    const paid = await bridge.buy(a.agentId, { solutionId: 'sf-0271', confidencePct: 80, category: 'compute_model' });
    expect(paid.status).toBe('PAID');
    await expect(bridge.approve(a.ownerId, paid.orderId!, {})).rejects.toThrow('NOT_AWAITING_APPROVAL');
  });
});

describe('Connected agents (Claude, ChatGPT, …) shop AgentBazaar over MCP', () => {
  const rpc = (name: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

  async function connected(scopes: string[], m = { maxPerTxMinor: 3_000n, maxDailyMinor: 5_000n, allowedServices: ['agentbazaar'] }) {
    const a = await agent();
    const { token } = await connect.createConnection(a.ownerId, a.agentId, { provider: 'chatgpt', scopes, mandate: m });
    const ctx = await connect.authenticate(token!);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r: any = await handleMcpMessage(ctx, rpc(name, args), { dev, wallet, gas, bazaar: bridge });
      return { isError: r.result.isError, out: r.result.structuredContent };
    };
    return { ...a, ctx, call };
  }

  it('buys within the connection mandate (auto-enabled), and the mandate spans purchases', async () => {
    const c = await connected(['context:read', 'bazaar:buy']);
    const tools: any = await handleMcpMessage(c.ctx, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { dev, wallet, gas, bazaar: bridge });
    const names = tools.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['bazaar_search', 'bazaar_buy', 'bazaar_run', 'bazaar_report', 'bazaar_purchases']));
    expect(names.some((n: string) => /attest/.test(n))).toBe(false);   // only the human owner attests

    expect((await c.call('bazaar_buy', { solution_id: 'sf-0163', confidence_pct: 80 })).out.reasons).toContain('MANDATE_PER_TX_LIMIT');   // $55 > $30
    const first = await c.call('bazaar_buy', { solution_id: 'sf-0152', confidence_pct: 80 });                                         // $28
    expect(first.isError).toBe(false);
    expect(first.out.status).toBe('PAID');
    expect(first.out.receiptVerified).toBe(true);
    const second = await c.call('bazaar_buy', { solution_id: 'sf-0271', confidence_pct: 70 });                                        // $15 → $43 of $50
    expect(second.out.status).toBe('PAID');
    const third = await c.call('bazaar_buy', { solution_id: 'sf-0170', confidence_pct: 70 });                                         // $19 → would be $62
    expect(third.out.reasons).toContain('MANDATE_DAILY_LIMIT');

    const run = (await c.call('bazaar_run', { receipt_id: first.out.receiptId, input: { holdings: [{ value: 20_000, expense_ratio: 0.01 }] } })).out;
    expect(run.output.annual_fee_drag).toBe(200);
    expect((await c.call('bazaar_report', { run_id: run.runId, success: true })).out.awaiting).toBe('owner_attestation');
    const ctxOut = (await c.call('get_agent_context')).out;
    expect(ctxOut.bazaar.enabled).toBe(true);
    expect((await c.call('bazaar_purchases')).out.orders.filter((o: any) => o.status === 'PAID')).toHaveLength(2);
  });

  it('a connection without bazaar:buy cannot shop', async () => {
    const c = await connected(['context:read', 'market:read']);
    const r = await c.call('bazaar_buy', { solution_id: 'sf-0152', confidence_pct: 80 });
    expect(r.isError).toBe(true);
    expect(r.out.error).toBe('SCOPE_NOT_GRANTED');
  });

  it('forwards the agent-stated purchase context; a CONFIRM category holds for the owner', async () => {
    const c = await connected(['context:read', 'bazaar:buy']);
    const r = await c.call('bazaar_buy', {
      solution_id: 'sf-0152', confidence_pct: 80,
      category: 'donations_contributions', trigger: 'user asked to donate', beneficiary: 'Example Charity',
      // an agent cannot self-approve: even if it tried, ownerApproved is not a tool field
      ownerApproved: true,
    });
    expect(r.out.status).toBe('APPROVAL_REQUIRED');
    const order = await prisma.bazaarOrder.findUnique({ where: { id: r.out.orderId } });
    expect(order?.category).toBe('donations_contributions');
    expect(order?.trigger).toBe('user asked to donate');
    expect(order?.permission).toBe('CONFIRM');
    expect(order?.chargeId).toBeNull();                    // nothing charged while it waits
  });
});

describe('Trust and operations: PayPali identity (dev → KYC), measured attestation, refunds, payouts, revocation', () => {
  let issuer: IdentityIssuer, kyc: KycService;
  beforeEach(async () => {
    // Restart the Bazaar with PayPali registered as an identity issuer (min assurance: dev, so both levels count here).
    bazaar.server.close();
    issuer = IdentityIssuer.generate('paypali').issuer;
    bazaar = await start(0, { payments: inProcessPayments(merchants), tickMs: 100, identityIssuers: [{ id: issuer.id, public_key: issuer.publicKey }], minAssurance: 'dev' });
    kyc = new KycService(prisma, issuer, new SandboxKycProvider('http://paypali.test'), { fingerprintKey: Buffer.alloc(32, 7), revocationSinks: [bazaar.url] });
    bridge = new BazaarBridge(prisma, dev, merchants, gas, new BazaarClient(bazaar.url));
    bridge.identity = kyc;
    merchants.payoutBindingCheck = (b, to) => kyc.verifyPayoutBinding(b as any, to);
    merchants.requirePayoutBinding = true;
  });
  const passKyc = async (ownerId: string, payerId = 'PAYERJENNY01') => {
    const s: any = await kyc.start(ownerId);
    return kyc.complete(s.url.split('/').pop(), { outcome: 'approve', payerId });
  };
  /** A PayPali owner who sells on the Bazaar: identity credential for the vendor key, payout to their own agent. */
  async function vendorOwner(handler: (d: any) => any = () => ({ output: { ok: true } })) {
    const v = await agent(0n);
    const vk = new Identity();
    await bzCall(bazaar.url, vk, 'POST', '/v1/principals', {});
    await bzCall(bazaar.url, vk, 'POST', '/v1/principals/me/identity', { credential: await kyc.credentialFor(v.ownerId, vk.pub) });
    const ep = await createVendorEndpoint({ identity: vk, marketBase: bazaar.url, handlers: { 'solution.invoke': async (d: any) => handler(d) } });
    const reg = await bzCall(bazaar.url, vk, 'POST', '/v1/vendors', { display_name: 'Owner Vendor', webhook_url: ep.url, payout_agent_id: v.agentId, payout_binding: await kyc.payoutBinding(v.ownerId, v.agentId, vk.pub) });
    return { ...v, vk, ep, reg };
  }

  it('enable() presents a dev credential; after KYC a person-level kyc credential; the owner attests what they observed', async () => {
    const a = await agent();
    const acct = await bridge.enable(a.ownerId, a.agentId);
    expect(acct.identity).toMatchObject({ issuer: 'paypali', assurance: 'dev', method: 'account', countsAsEvidence: true });
    expect((await passKyc(a.ownerId)).status).toBe('VERIFIED');
    expect(await bridge.attachIdentity(a.ownerId)).toMatchObject({ assurance: 'kyc', method: 'sandbox', countsAsEvidence: true });

    const r = await bridge.buy(a.agentId, { solutionId: 'sf-0170', confidencePct: 70 });   // metric listing: annual_gain (USD)
    const run = await bridge.run(a.agentId, r.receiptId!, { cash: 10_000, apy_now: 0.01, apy_best: 0.05 });
    await bridge.report(a.agentId, run.runId, true, run.output.annual_gain);
    await expect(bridge.attest(a.ownerId, run.runId, 'confirm')).rejects.toThrow('observed_required');
    const at = await bridge.attest(a.ownerId, run.runId, undefined, 'bank shows +$120', 120);
    expect(at).toMatchObject({ final_success: true, human_observed: 120, agent_observed: 400, observation_mismatch: true, counts_as_evidence: true });
    const stake = await until(async () => { const s = await prisma.scoreStake.findUnique({ where: { id: r.stakeId! } }); return s?.status === 'WON' ? s : null; });
    expect((stake.evidence as any).observation_mismatch).toBe(true);
  });

  it('one verified person cannot back two Bazaar principals, even from two PayPali accounts', async () => {
    const a = await agent(), b = await agent();
    await passKyc(a.ownerId);
    expect((await passKyc(b.ownerId)).status).toBe('DUPLICATE');   // PayPali refuses the second account at KYC time
    await bridge.enable(a.ownerId, a.agentId);
    const other = new Identity();
    await bzCall(bazaar.url, other, 'POST', '/v1/principals', {});
    const dup = await bzCall(bazaar.url, other, 'POST', '/v1/principals/me/identity', { credential: await kyc.credentialFor(a.ownerId, other.pub) });
    expect(dup.status).toBe(409);   // and the Bazaar refuses a second principal for the same person
  });

  it('vendor payouts reach the vendor’s own PayPali agent only through a verified binding', async () => {
    const v = await vendorOwner();
    expect(v.reg.status).toBe(200);
    expect(v.reg.body).toMatchObject({ identity_verified: true, payout_verified: true, payout_hold: null });
    const listing = (await bzCall(bazaar.url, v.vk, 'POST', '/v1/solutions', { name: 'Owner Tool', category: 'Ops', price: 10, claimed_success: 0.9 })).body;
    const a = await agent();
    await bridge.enable(a.ownerId, a.agentId);
    const r = await bridge.buy(a.agentId, { solutionId: listing.id, confidencePct: 80 });
    await bridge.run(a.agentId, r.receiptId!);
    await until(async () => (await wallet.getBalance(v.agentId, USD)) === 900n);   // $10 less the 10% marketplace fee
    // Someone else's agent cannot be named as the payout account.
    const thief = await agent(0n), tk = new Identity();
    await bzCall(bazaar.url, tk, 'POST', '/v1/principals', {});
    await bzCall(bazaar.url, tk, 'POST', '/v1/principals/me/identity', { credential: await kyc.credentialFor(thief.ownerId, tk.pub) });
    const tep = await createVendorEndpoint({ identity: tk, marketBase: bazaar.url });
    await expect(kyc.payoutBinding(thief.ownerId, v.agentId, tk.pub)).rejects.toThrow('AGENT_NOT_OWNED');
    const steal = await bzCall(bazaar.url, tk, 'POST', '/v1/vendors', { display_name: 'Thief', webhook_url: tep.url, payout_agent_id: v.agentId, payout_binding: await kyc.payoutBinding(v.ownerId, v.agentId, v.vk.pub) });
    expect(steal.status).toBe(400);   // a binding issued to the real vendor's key cannot be reused
    expect(steal.body.error).toBe('payout_binding_mismatch');
    await tep.close(); await v.ep.close();
  });

  it('a revoked owner is cut off: identity unbound at the Bazaar, listings hidden, payouts held', async () => {
    const v = await vendorOwner();
    const listing = (await bzCall(bazaar.url, v.vk, 'POST', '/v1/solutions', { name: 'Revoked Tool', category: 'Ops', price: 10, claimed_success: 0.9 })).body;
    const r = await kyc.revoke(v.ownerId, 'fraud');
    expect(r.pushed).toBeGreaterThanOrEqual(1);
    const me = await bzCall(bazaar.url, v.vk, 'GET', '/v1/vendors/me');
    expect(me.body).toMatchObject({ identity_verified: false, selling: false, payout_hold: 'vendor_identity_revoked' });
    expect((await bridge.search({ query: 'revoked' })).results).toHaveLength(0);
    await expect(kyc.credentialFor(v.ownerId, v.vk.pub)).rejects.toThrow('IDENTITY_REVOKED');
    expect(await kyc.verifyPayoutBinding(await (async () => { try { return await kyc.payoutBinding(v.ownerId, v.agentId, v.vk.pub); } catch { return null; } })(), v.agentId)).toBe('PAYOUT_BINDING_REQUIRED');
    void listing; await v.ep.close();
  });

  it('a vendor that never delivers is refunded through PayPali: money back, grant restored, stake LOST', async () => {
    const v = await vendorOwner();
    const listing = (await bzCall(bazaar.url, v.vk, 'POST', '/v1/solutions', { name: 'Ghost Tool', category: 'Ops', price: 15, claimed_success: 0.9 })).body;
    const a = await agent();
    const acct = await bridge.enable(a.ownerId, a.agentId);
    const r = await bridge.buy(a.agentId, { solutionId: listing.id, confidencePct: 80 });
    expect(r.status).toBe('PAID');
    await v.ep.close();
    await expect(bridge.refund(a.agentId, r.receiptId!)).rejects.toThrow('vendor_still_within_delivery_window');
    for (let i = 0; i < 2; i++) await expect(bridge.run(a.agentId, r.receiptId!)).rejects.toThrow('vendor_unavailable');
    const rf = await bridge.refund(a.agentId, r.receiptId!);
    expect(rf.status).toBe('refunded');
    const charge = await prisma.merchantCharge.findUniqueOrThrow({ where: { id: r.chargeId! } });
    expect(charge.status).toBe('REFUNDED');
    expect((await merchants.getGrant('agentbazaar', acct.grantId!)).usedMinor).toBe(0n);
    expect((await prisma.scoreStake.findUniqueOrThrow({ where: { id: r.stakeId! } })).status).toBe('LOST');
    expect(await wallet.getReserved(a.agentId, USD)).toBe(0n);
    await expect(bridge.run(a.agentId, r.receiptId!)).rejects.toThrow('receipt_refunded');
  });
});
