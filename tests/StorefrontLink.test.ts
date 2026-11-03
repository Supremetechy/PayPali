import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { AgentWalletService } from '../src/services/AgentWalletService';
import { AgentDevService } from '../src/agentdev/AgentDevService';
import { MerchantService } from '../src/merchant/MerchantService';
import { IdentityIssuer } from '../src/bazaar/IdentityIssuer';
import { KycService } from '../src/bazaar/KycService';
import { SandboxKycProvider } from '../src/bazaar/kycProviders';
import { StorefrontLinkService, vendorIdOf } from '../src/bazaar/StorefrontLink';
import { storefrontOrigins } from '../src/bazaar/linkRoutes';
import { createTestDb, TestDb } from './harness';

// Connect PayPali from the Solutions Farm storefront, against the real AgentBazaar (in-process).
const require = createRequire(import.meta.url);
const { start } = require('../AgentBazaar/server.js');
const { Identity, call: bz } = require('../AgentBazaar/client.js');
const { createVendorEndpoint } = require('../AgentBazaar/vendor-kit.js');

const M = 'agentbazaar', USD = 'USD';
let db: TestDb, prisma: PrismaClient, wallet: AgentWalletService, dev: AgentDevService, merchants: MerchantService;
let kyc: KycService, links: StorefrontLinkService, bazaar: { server: any; url: string };

const s = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
function payments(ms: MerchantService) {
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
  db = await createTestDb(); prisma = db.prisma;
  wallet = new AgentWalletService(prisma); dev = new AgentDevService(prisma, wallet);
  merchants = new MerchantService(prisma, wallet, dev.score, [{ id: M, secret: 'test-secret-0123456789abcdef' }]);
  const issuer = IdentityIssuer.generate('paypali').issuer;
  kyc = new KycService(prisma, issuer, new SandboxKycProvider('http://paypali.test'), { fingerprintKey: randomBytes(32) });
  links = new StorefrontLinkService({ prisma, dev, merchants, kyc, merchantId: M });
  // As in paypaliServer: the KYC binding check, then the owner's storefront unlink.
  merchants.payoutBindingCheck = async (b, to) => (await kyc.verifyPayoutBinding(b as any, to)) ?? links.payoutBlocked((b as any)?.body?.vendor_pub, to);
  merchants.requirePayoutBinding = true;
  bazaar = await start(0, { payments: payments(merchants), tickMs: 100, identityIssuers: [{ id: issuer.id, public_key: issuer.publicKey }], minAssurance: 'dev' });
});
afterEach(async () => { bazaar.server.close(); await db.close(); });

async function agent(fund = 50_000n) {
  const owner = await prisma.owner.create({ data: { email: `o_${randomUUID()}@example.com` } });
  const a = await prisma.agent.create({ data: { ownerId: owner.id, name: 'Shopper' } });
  if (fund > 0n) await wallet.receive({ agentId: a.id, amountMinor: fund, currency: USD, idempotencyKey: randomUUID() });
  return { ownerId: owner.id, agentId: a.id };
}
const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 6000): Promise<T> => {
  const t = Date.now();
  for (;;) { const v = await fn(); if (v) return v as T; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); }
};
/** What the storefront tab does with a BUY link result: principal + identity, then a mandate funded by the grant. */
async function browserBuyer(grantId: string, credential: unknown, human = new Identity()) {
  const ag = new Identity();
  await bz(bazaar.url, human, 'POST', '/v1/principals', {});
  const id = await bz(bazaar.url, human, 'POST', '/v1/principals/me/identity', { credential });
  const body = { mid: 'm_' + randomUUID().slice(0, 12), principal_pub: human.pub, agent_pub: ag.pub, budget: 50, cap: 30, min_tier: 1, categories: ['*'], exp: Date.now() + 3_600_000, funding: { provider: 'paypali', grant_id: grantId } };
  const { canon } = require('../AgentBazaar/core.js');
  const mand = await bz(bazaar.url, human, 'POST', '/v1/mandates', { mandate: { body, sig: human.sign(canon(body)) } });
  return { human, ag, mid: body.mid, identity: id, mandate: mand };
}

describe('Connect PayPali: the Solutions Farm storefront linked to PayPali accounts', () => {
  it('BUY: the browser key buys with the linked agent’s wallet; the grant works for that key only; revoking stops it', async () => {
    const a = await agent();
    const human = new Identity();
    const out = await links.link(a.ownerId, { role: 'BUY', agentId: a.agentId, pub: human.pub, budgetMinor: 5_000n });
    expect(out.grant).toMatchObject({ status: 'ACTIVE', maxMinor: 5_000n, principalPub: human.pub });
    expect(out.credential).toBeTruthy();

    const b = await browserBuyer(out.grant!.grantId, out.credential, human);
    expect(b.identity.status).toBe(200);
    expect(b.mandate.status).toBe(200);
    const q = await bz(bazaar.url, b.ag, 'POST', '/v1/quote', { solution_id: 'sf-0152' }, b.mid);
    const p = await bz(bazaar.url, b.ag, 'POST', '/v1/purchase', { quote_id: q.body.body.qid, confidence_pct: 80 }, b.mid);
    expect(p.status).toBe(200);
    expect(await wallet.getBalance(a.agentId, USD)).toBeLessThan(50_000n);                  // paid from the linked agent

    // A leaked grant id is useless to any other key.
    const thief = await browserBuyer(out.grant!.grantId, await kyc.credentialFor((await agent(0n)).ownerId, (new Identity()).pub));
    expect(thief.mandate).toMatchObject({ status: 403, body: { error: 'grant_bound_to_other_principal' } });

    const [view] = await links.list(a.ownerId);
    expect(view).toMatchObject({ role: 'BUY', status: 'ACTIVE', agentName: 'Shopper' });
    expect(view.grant!.usedMinor).toBeGreaterThan(0n);
    await links.revoke(a.ownerId, view.id);
    expect((await links.list(a.ownerId))[0].status).toBe('REVOKED');
    const again = await browserBuyer(out.grant!.grantId, out.credential, human);
    expect(again.mandate).toMatchObject({ status: 402, body: { error: 'grant_not_active' } });
  });

  it('BUY: re-linking the same key replaces its grant; links are owner acts on the owner’s own active agents', async () => {
    const a = await agent(), other = await agent();
    const k = new Identity();
    const one = await links.link(a.ownerId, { role: 'BUY', agentId: a.agentId, pub: k.pub });
    const two = await links.link(a.ownerId, { role: 'BUY', agentId: a.agentId, pub: k.pub, budgetMinor: 2_000n });
    expect((await merchants.getGrant(M, one.grant!.grantId)).status).toBe('REVOKED');
    expect((await merchants.getGrant(M, two.grant!.grantId)).status).toBe('ACTIVE');
    await expect(links.link(a.ownerId, { role: 'BUY', agentId: other.agentId, pub: k.pub })).rejects.toThrow('AGENT_NOT_OWNED');
    await expect(links.link(a.ownerId, { role: 'BUY', agentId: a.agentId, pub: 'not-a-key' })).rejects.toThrow('BAD_STOREFRONT_KEY');
    await expect(links.link(a.ownerId, { role: 'BUY', agentId: a.agentId, pub: k.pub, budgetMinor: 0n })).rejects.toThrow('INVALID_BUDGET');
    await prisma.agent.update({ where: { id: a.agentId }, data: { isActive: false } });
    await expect(links.link(a.ownerId, { role: 'BUY', agentId: a.agentId, pub: k.pub })).rejects.toThrow('AGENT_INACTIVE');
  });

  it('SELL: one link verifies the vendor and pays sales into the agent; “Stop payouts” blocks further payouts', async () => {
    const seller = await agent(0n);
    const vk = new Identity();
    const out = await links.link(seller.ownerId, { role: 'SELL', agentId: seller.agentId, pub: vk.pub });
    expect(out.link.vendorId).toBe(vendorIdOf(vk.pub));
    // What the storefront does with the result: principal + credential, then register with the binding.
    await bz(bazaar.url, vk, 'POST', '/v1/principals', {});
    expect((await bz(bazaar.url, vk, 'POST', '/v1/principals/me/identity', { credential: out.credential })).status).toBe(200);
    const ep = await createVendorEndpoint({ identity: vk, marketBase: bazaar.url, handlers: { 'solution.invoke': async () => ({ output: { ok: true } }) } });
    const reg = await bz(bazaar.url, vk, 'POST', '/v1/vendors', { display_name: 'Farm Seller', webhook_url: ep.url, payout_agent_id: seller.agentId, payout_binding: out.binding });
    expect(reg.status).toBe(200);
    expect(reg.body).toMatchObject({ vendor_id: out.link.vendorId, identity_verified: true, payout_verified: true });
    expect(await links.vendorIds(seller.ownerId)).toEqual([out.link.vendorId]);

    const listing = (await bz(bazaar.url, vk, 'POST', '/v1/solutions', { name: 'Farm Tool', category: 'Ops', price: 10, claimed_success: 0.9 })).body;
    const search = { body: (await (await fetch(bazaar.url + '/v1/search?q=farm')).json()) as any };
    expect(search.body.results.find((x: any) => x.id === listing.id).vendor.id).toBe(out.link.vendorId);   // the Marketplace's “Yours” tag

    const buyer = await agent(), bk = new Identity();
    const bl = await links.link(buyer.ownerId, { role: 'BUY', agentId: buyer.agentId, pub: bk.pub });
    const b = await browserBuyer(bl.grant!.grantId, bl.credential, bk);
    const q = await bz(bazaar.url, b.ag, 'POST', '/v1/quote', { solution_id: listing.id }, b.mid);
    const p = await bz(bazaar.url, b.ag, 'POST', '/v1/purchase', { quote_id: q.body.body.qid, confidence_pct: 80 }, b.mid);
    await bz(bazaar.url, b.ag, 'POST', '/v1/invoke', { receipt_id: p.body.body.rid, input: {} }, b.mid);
    await until(async () => (await wallet.getBalance(seller.agentId, USD)) === 900n);       // $10 less the 10% fee

    const [sell] = await links.list(seller.ownerId);
    await links.revoke(seller.ownerId, sell.id);
    expect(await links.vendorIds(seller.ownerId)).toEqual([]);
    await expect(merchants.payout(M, { toAgentId: seller.agentId, amountMinor: 100n, currency: USD, idempotencyKey: randomUUID(), binding: out.binding }))
      .rejects.toThrow('PAYOUT_UNLINKED_BY_OWNER');
  });

  it('one person can buy and sell: one buying principal plus one vendor-only key, never two of either', async () => {
    const me = await agent();
    const human = new Identity(), vk = new Identity(), vk2 = new Identity(), other = new Identity();
    const buy = await links.link(me.ownerId, { role: 'BUY', agentId: me.agentId, pub: human.pub });
    expect((await browserBuyer(buy.grant!.grantId, buy.credential, human)).identity.status).toBe(200);
    const sell = await links.link(me.ownerId, { role: 'SELL', agentId: me.agentId, pub: vk.pub });
    await bz(bazaar.url, vk, 'POST', '/v1/principals', {});
    expect((await bz(bazaar.url, vk, 'POST', '/v1/principals/me/identity', { credential: sell.credential })).body.error).toBe('identity_already_bound');   // plain attach: a 2nd buyer
    expect((await bz(bazaar.url, vk, 'POST', '/v1/principals/me/identity', { credential: sell.credential, as: 'vendor' })).status).toBe(200);
    // The vendor-only key cannot buy (so it cannot attest either).
    const { canon } = require('../AgentBazaar/core.js');
    const body = { mid: 'm_' + randomUUID().slice(0, 12), principal_pub: vk.pub, agent_pub: new Identity().pub, budget: 10, cap: 5, min_tier: 1, categories: ['*'], exp: Date.now() + 3_600_000, funding: { provider: 'paypali', grant_id: buy.grant!.grantId } };
    expect((await bz(bazaar.url, vk, 'POST', '/v1/mandates', { mandate: { body, sig: vk.sign(canon(body)) } })).body.error).toBe('vendor_key_cannot_buy');
    // Still one buying principal per person.
    await bz(bazaar.url, other, 'POST', '/v1/principals', {});
    expect(await bz(bazaar.url, other, 'POST', '/v1/principals/me/identity', { credential: await kyc.credentialFor(me.ownerId, other.pub) }))
      .toMatchObject({ status: 409, body: { error: 'identity_already_bound' } });
    // One vendor key per person: a NEWER credential (the owner linked a new key, e.g. after losing the tab) replaces the old one…
    await new Promise((r) => setTimeout(r, 5));
    const relink = await links.link(me.ownerId, { role: 'SELL', agentId: me.agentId, pub: vk2.pub });
    await bz(bazaar.url, vk2, 'POST', '/v1/principals', {});
    expect((await bz(bazaar.url, vk2, 'POST', '/v1/principals/me/identity', { credential: relink.credential, as: 'vendor' })).status).toBe(200);
    expect((await bz(bazaar.url, vk, 'GET', '/v1/principals/me')).body.identity).toBeNull();
    // …and the old, older credential cannot take it back.
    expect(await bz(bazaar.url, vk, 'POST', '/v1/principals/me/identity', { credential: sell.credential, as: 'vendor' }))
      .toMatchObject({ status: 409, body: { error: 'identity_already_bound' } });
    expect((await links.list(me.ownerId)).filter((l) => l.role === 'SELL').map((l) => l.status)).toEqual(['ACTIVE', 'REVOKED']);   // the new key retires the old link
    expect(await links.vendorIds(me.ownerId)).toEqual([vendorIdOf(vk2.pub)]);
  });

  it('results are only handed back to the configured storefront origin', () => {
    expect(storefrontOrigins('http://localhost:8787')).toEqual(['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']);
    expect(storefrontOrigins('https://farm.example.com/x')).toEqual(['https://farm.example.com']);
    expect(storefrontOrigins(null)).toEqual([]);
  });
});
