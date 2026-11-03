import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { AgentWalletService } from '../src/services/AgentWalletService';
import { AgentDevService } from '../src/agentdev/AgentDevService';
import { AgentConnectService } from '../src/connect/AgentConnectService';
import { LivePaymentService } from '../src/services/LivePaymentService';
import { DevPayPalCommerceGateway } from '../src/providers/paypal/DevPayPalCommerceGateway';
import { DevBrowserCheckoutDriver } from '../src/providers/checkout/DevBrowserCheckoutDriver';
import { OnboardingService } from '../src/onboarding/OnboardingService';
import { SeedFundingWorker } from '../src/workers/SeedFundingWorker';
import { IdentityIssuer } from '../src/bazaar/IdentityIssuer';
import { FundingService, addPeriod, periodKeyFor } from '../src/funding/FundingService';
import { DevFundingProvider, PayPalFundingProvider } from '../src/funding/providers';
import { AgencyService } from '../src/agency/AgencyService';
import { createTestDb, TestDb } from './harness';

const USD = 'USD';
let db: TestDb, prisma: PrismaClient, wallet: AgentWalletService, dev: AgentDevService, connect: AgentConnectService;
let provider: DevFundingProvider, funding: FundingService, agency: AgencyService, live: LivePaymentService, issuer: IdentityIssuer;
let clock: number;
const now = () => new Date(clock);

beforeEach(async () => {
  db = await createTestDb();
  prisma = db.prisma;
  clock = Date.UTC(2026, 10, 2, 9, 0, 0);
  wallet = new AgentWalletService(prisma);
  dev = new AgentDevService(prisma, wallet, {}, now);
  connect = new AgentConnectService(prisma, dev);
  live = new LivePaymentService(prisma, wallet, new DevPayPalCommerceGateway(), new DevBrowserCheckoutDriver());
  provider = new DevFundingProvider('http://pp.test');
  funding = new FundingService(prisma, wallet, provider, live, { publicUrl: 'http://pp.test', now });
  issuer = IdentityIssuer.generate('paypali').issuer;
  agency = new AgencyService({ prisma, score: dev.score, connect, funding, issuer, now });
});
afterEach(async () => db.close());

async function agent(fund = 0n) {
  const o = await prisma.owner.create({ data: { email: `o_${randomUUID()}@example.com` } });
  const a = await prisma.agent.create({ data: { ownerId: o.id, name: 'steward', objectiveType: 'SUSTAIN', objectiveMandate: 'Keep my subscriptions paid at the best price.' } });
  if (fund > 0n) await wallet.receive({ agentId: a.id, amountMinor: fund, currency: USD, idempotencyKey: randomUUID() });
  return { ownerId: o.id, agentId: a.id };
}
const approve = (approveUrl: string) => new URL(provider.decide(approveUrl.split('/').pop()!, true)!);

// ===========================================================================
describe('Funding an agent from PayPal', () => {
  it('top-up: order → owner approves at PayPal → capture credits the agent once, however many times capture is called', async () => {
    const a = await agent();
    const o = await funding.createTopUp(a.ownerId, a.agentId, { amountMinor: 2_500n, currency: USD, returnPath: '/dashboard?agent=x' });
    expect(o.approveUrl).toMatch(/^http:\/\/pp\.test\/fund\/dev\/DEV/);
    expect((await funding.capture(o.orderId) as any).pending).toBe(true);           // not approved yet: nothing credited
    expect(await wallet.getBalance(a.agentId, USD)).toBe(0n);
    const back = approve(o.approveUrl);
    expect(back.pathname).toBe('/fund/return');
    expect(back.searchParams.get('f')).toBe(o.fundingId);
    expect(back.searchParams.get('next')).toBe('/dashboard?agent=x');
    const r1 = await funding.capture(o.orderId), r2 = await funding.capture(o.orderId);
    expect(r1).toMatchObject({ status: 'CAPTURED', purpose: 'TOPUP' });
    expect(r2.captureId).toBe(r1.captureId);
    expect(await wallet.getBalance(a.agentId, USD)).toBe(2_500n);
  });

  it('refuses other owners, inactive agents, bad amounts and other currencies', async () => {
    const a = await agent(), b = await agent();
    await expect(funding.createTopUp(b.ownerId, a.agentId, { amountMinor: 500n, currency: USD })).rejects.toThrow('AGENT_NOT_OWNED');
    await expect(funding.createTopUp(a.ownerId, a.agentId, { amountMinor: 50n, currency: USD })).rejects.toThrow('INVALID_FUNDING_AMOUNT');
    await expect(funding.createTopUp(a.ownerId, a.agentId, { amountMinor: 500n, currency: 'EUR' })).rejects.toThrow('CURRENCY_NOT_SUPPORTED');
    await prisma.agent.update({ where: { id: a.agentId }, data: { isActive: false } });
    await expect(funding.createTopUp(a.ownerId, a.agentId, { amountMinor: 500n, currency: USD })).rejects.toThrow('AGENT_INACTIVE');
  });

  it('cancelled at PayPal: nothing credited, order closed', async () => {
    const a = await agent();
    const o = await funding.createTopUp(a.ownerId, a.agentId, { amountMinor: 900n, currency: USD });
    provider.decide(o.orderId, false);
    expect((await funding.cancel(o.fundingId)).status).toBe('CANCELLED');
    expect((await funding.capture(o.orderId)).status).toBe('CANCELLED');
    expect(await wallet.getBalance(a.agentId, USD)).toBe(0n);
  });

  it('seed: onboarding with an approved PayPal order; the worker captures it; the order funds exactly one seed', async () => {
    const live = new FundingService(prisma, wallet, Object.assign(provider, { id: 'paypal:sandbox' }) as any, null, { publicUrl: 'http://pp.test', now });
    const o = await live.createSeedOrder({ amountMinor: 50_000n, currency: USD, saveForAllowance: true });
    expect(await live.checkSeedReference(o.orderId, 40_000n, USD)).toBe('SEED_AMOUNT_DIFFERS_FROM_APPROVAL');
    expect(await live.checkSeedReference('vault_dev_demo', 50_000n, USD)).toBe('SEED_NEEDS_PAYPAL_APPROVAL');
    expect(await live.checkSeedReference(o.orderId, 50_000n, USD)).toBeNull();
    approve(o.approveUrl);
    const onboarding = new OnboardingService(prisma);
    const g = await onboarding.generateAgent({ owner: { email: 'seed@example.com' }, objective: { type: 'GROWTH' }, seed: { amountMinor: 50_000n, currency: USD, fundingSourceReference: o.orderId } } as any);
    const worker = new SeedFundingWorker(prisma, live.seedGateway({ captureFromBalance: async () => ({ status: 'FAILED', reason: 'should not be used' }) }), { pollIntervalMs: 10, leaseDurationMs: 5000, retryBaseMs: 10, maxAttempts: 3 });
    expect(await worker.processNext()).toBe(true);
    expect(await wallet.getBalance(g.agentId, USD)).toBe(50_000n);
    const row = await prisma.fundingOrder.findUniqueOrThrow({ where: { providerOrderId: o.orderId } });
    expect(row).toMatchObject({ status: 'CAPTURED', agentId: g.agentId, ownerId: g.ownerId });
    expect(await live.checkSeedReference(o.orderId, 50_000n, USD)).toBe('FUNDING_ORDER_ALREADY_USED');
    // The PayPal account was saved for allowances, sealed at rest.
    const pm = await live.paymentMethods(g.ownerId);
    expect(pm).toHaveLength(1);
    expect((await prisma.ownerPaymentMethod.findFirstOrThrow()).vaultIdSealed).not.toMatch(/^devvault_/);
  });

  it('without PayPal configured any seed reference is simulated (the original dev behaviour)', async () => {
    expect(await funding.checkSeedReference('paypal_bal_1', 1_000n, USD)).toBeNull();
  });
});

// ===========================================================================
describe('Allowances', () => {
  it('saved PayPal: charged once per period without asking; a decline pauses it', async () => {
    const a = await agent();
    const o = await funding.createTopUp(a.ownerId, a.agentId, { amountMinor: 1_000n, currency: USD, saveForAllowance: true });
    approve(o.approveUrl); await funding.capture(o.orderId);
    const [pm] = await funding.paymentMethods(a.ownerId);
    const al = await funding.setAllowance(a.ownerId, a.agentId, { amountMinor: 2_000n, period: 'WEEKLY' });
    expect(al).toMatchObject({ mode: 'SAVED_PAYPAL', paymentMethodId: pm.id, status: 'ACTIVE' });
    expect(await funding.runDueAllowances()).toBe(1);
    expect(await funding.runDueAllowances()).toBe(0);                         // same week: nothing more
    expect(await wallet.getBalance(a.agentId, USD)).toBe(3_000n);
    clock += 7 * 86_400_000;
    provider.declineNextSavedCharge = true;
    expect(await funding.runDueAllowances()).toBe(0);
    const after = await funding.getAllowance(a.agentId);
    expect(after).toMatchObject({ status: 'PAUSED', lastError: 'PAYPAL_DECLINED:INSTRUMENT_DECLINED' });
    expect(after!.runs.map((r) => r.status)).toEqual(['DECLINED', 'CAPTURED']);
    expect(await wallet.getBalance(a.agentId, USD)).toBe(3_000n);
  });

  it('no saved PayPal: each period creates an order the owner approves', async () => {
    const a = await agent();
    await funding.setAllowance(a.ownerId, a.agentId, { amountMinor: 1_500n, period: 'MONTHLY' });
    expect(await funding.runDueAllowances()).toBe(1);
    const al = await funding.getAllowance(a.agentId);
    expect(al!.mode).toBe('APPROVE_EACH_PERIOD');
    expect(al!.runs[0]).toMatchObject({ status: 'AWAITING_APPROVAL', periodKey: '2026-11' });
    approve(al!.runs[0].approveUrl!);
    const f = await prisma.fundingOrder.findFirstOrThrow({ where: { purpose: 'ALLOWANCE' } });
    await funding.capture(f.providerOrderId);
    expect(await wallet.getBalance(a.agentId, USD)).toBe(1_500n);
    expect((await funding.getAllowance(a.agentId))!.runs[0].status).toBe('CAPTURED');
  });

  it('periods: weekly keys are ISO weeks, monthly adds a calendar month without overflowing', () => {
    expect(periodKeyFor(new Date(Date.UTC(2026, 0, 1)), 'WEEKLY')).toBe('2026-W01');
    expect(periodKeyFor(new Date(Date.UTC(2027, 0, 1)), 'WEEKLY')).toBe('2026-W53');
    expect(addPeriod(new Date(Date.UTC(2026, 0, 31)), 'MONTHLY').toISOString().slice(0, 10)).toBe('2026-02-28');
  });
});

// ===========================================================================
describe('Beneficiary sweeps (money out through Payouts)', () => {
  it('pays everything above the working balance to the beneficiary', async () => {
    const a = await agent(12_000n);
    await expect(funding.setSweep(a.ownerId, a.agentId, { receiver: 'not-an-email', keepMinor: 0n, period: 'MANUAL' })).rejects.toThrow('BENEFICIARY_EMAIL_REQUIRED');
    await funding.setSweep(a.ownerId, a.agentId, { receiver: 'Beneficiary@Example.com', keepMinor: 2_000n, period: 'MANUAL' });
    const r = await funding.sweepNow(a.ownerId, a.agentId);
    expect(r).toMatchObject({ status: 'PAID', amountMinor: '10000', receiver: 'beneficiary@example.com' });
    expect(await wallet.getBalance(a.agentId, USD)).toBe(2_000n);
    expect(await funding.sweepNow(a.ownerId, a.agentId)).toMatchObject({ status: 'NOTHING_TO_PAY' });
  });
});

// ===========================================================================
describe('Power of Agency', () => {
  it('freezes the agent’s authority, is countersigned by PayPali, and versions on change', async () => {
    const a = await agent(5_000n);
    await dev.score.open(a.agentId);
    await dev.skills.grantCapability(a.ownerId, a.agentId, 'market.service', 'MEDIUM');
    const d = await agency.draft(a.ownerId, a.agentId);
    expect(d).toMatchObject({ instrument: 'Power of Agency', objective: { type: 'SUSTAIN' }, capabilities: [{ capability: 'market.service', maxRisk: 'MEDIUM' }] });
    expect(d.duties.length).toBeGreaterThan(3);
    const diff = await agency.changedSinceSigned(a.ownerId, a.agentId);
    expect(diff.changed).toBe(true);
    const v1 = await agency.sign(a.ownerId, a.agentId, { acceptedTermsSha256: diff.draftTermsSha256 });
    expect(v1).toMatchObject({ version: 1, status: 'ACTIVE' });
    expect(issuer.verifyOwn(v1.document as any)).toBe(true);
    expect(await agency.verify(v1.document as any)).toMatchObject({ valid: true, status: 'ACTIVE' });
    expect((await agency.changedSinceSigned(a.ownerId, a.agentId)).changed).toBe(false);

    // Authority changes → the owner must review again; a stale acceptance is refused.
    await dev.skills.grantCapability(a.ownerId, a.agentId, 'data.query', 'HIGH');
    await expect(agency.sign(a.ownerId, a.agentId, { acceptedTermsSha256: diff.draftTermsSha256 })).rejects.toThrow('TERMS_CHANGED_REVIEW_AGAIN');
    const v2 = await agency.sign(a.ownerId, a.agentId);
    expect(v2.version).toBe(2);
    const cur = await agency.current(a.agentId);
    expect(cur.history.map((h) => h.status)).toEqual(['ACTIVE', 'SUPERSEDED']);
    expect(await agency.verify(v1.document as any)).toMatchObject({ valid: false, status: 'SUPERSEDED' });
  });

  it('when enforced, an agent without an active Power of Agency cannot pass a Score gate', async () => {
    const a = await agent(5_000n);
    await dev.score.open(a.agentId);
    await dev.skills.grantCapability(a.ownerId, a.agentId, 'market.service', 'HIGH');
    agency.enforce();
    const q = () => dev.score.quote({ agentId: a.agentId, capability: 'market.service', intentKey: 'k', confidencePct: 80, amountMinor: 100n });
    expect((await q()).reasons).toContain('POWER_OF_AGENCY_REQUIRED');
    await agency.sign(a.ownerId, a.agentId);
    expect((await q()).allowed).toBe(true);
  });
});

// ===========================================================================
describe('Kill switch', () => {
  it('one action stops the agent everywhere and revokes its Power of Agency; resume restores only the wallet', async () => {
    const a = await agent(20_000n);
    await dev.score.open(a.agentId);
    const { connection, token } = await connect.createConnection(a.ownerId, a.agentId, { provider: 'claude', scopes: ['gas:pay'], mandate: { maxPerTxMinor: 1_000n, maxDailyMinor: 5_000n } });
    await funding.setAllowance(a.ownerId, a.agentId, { amountMinor: 1_000n, period: 'WEEKLY', startNow: false });
    await funding.setSweep(a.ownerId, a.agentId, { receiver: 'b@example.com', keepMinor: 0n, period: 'WEEKLY' });
    const poa = await agency.sign(a.ownerId, a.agentId);
    const other = await agent();
    await expect(agency.stop(other.ownerId, a.agentId)).rejects.toThrow('AGENT_NOT_OWNED');

    const r = await agency.stop(a.ownerId, a.agentId, 'Suspicious spending');
    expect(r.effects).toMatchObject({ walletFrozen: true, connectionsRevoked: 1, allowancesPaused: 1, sweepsPaused: 1, powerOfAgencyRevoked: true });
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: a.agentId } })).isActive).toBe(false);
    await expect(connect.authenticate(token!)).rejects.toThrow();
    expect((await prisma.agentConnection.findUniqueOrThrow({ where: { id: connection.id } })).status).toBe('REVOKED');
    expect(await agency.verify(poa.document as any)).toMatchObject({ valid: false, status: 'REVOKED' });
    // Money can't move: debits, payouts and Score gates all refuse.
    await expect(wallet.send({ fromAgentId: a.agentId, toAgentId: other.agentId, amountMinor: 100n, currency: USD, idempotencyKey: randomUUID() })).rejects.toThrow('AGENT_INACTIVE');
    expect((await live.payoutExternal({ agentId: a.agentId, receiver: 'x@example.com', amountMinor: 100n, currency: USD, note: 'n', idempotencyKey: randomUUID() })).status).toBe('DECLINED');
    await expect(agency.sign(a.ownerId, a.agentId)).rejects.toThrow('AGENT_STOPPED_RESUME_FIRST');

    const back = await agency.resume(a.ownerId, a.agentId);
    expect(back.stopped).toBe(false);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: a.agentId } })).isActive).toBe(true);
    expect((await funding.getAllowance(a.agentId))!.status).toBe('PAUSED');     // re-enabled deliberately
    expect((await agency.current(a.agentId)).active).toBeNull();                  // needs a new signature
    expect((await agency.stopHistory(a.agentId)).map((e) => e.action)).toEqual(['RESUME', 'STOP']);
  });
});

// ===========================================================================
describe('PayPal REST adapter (request shapes, no network)', () => {
  it('creates a CAPTURE order with return/cancel URLs and the vault request; reads the vault id from the capture', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fake: any = async (url: string, init: any) => {
      calls.push({ url, init });
      const ok = (j: unknown, status = 200) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => j, text: async () => JSON.stringify(j) });
      if (url.endsWith('/v1/oauth2/token')) return ok({ access_token: 'tok', expires_in: 3600 });
      if (url.endsWith('/v2/checkout/orders') && JSON.parse(init.body).payment_source.paypal.vault_id) {
        return ok({ id: 'ORD2', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP2', status: 'COMPLETED', amount: { value: '20.00', currency_code: 'USD' } }] } }] }, 201);
      }
      if (url.endsWith('/v2/checkout/orders')) return ok({ id: 'ORD1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORD1' }] }, 201);
      if (url.endsWith('/ORD1/capture')) return ok({ id: 'ORD1', status: 'COMPLETED', payment_source: { paypal: { attributes: { vault: { id: 'V123', status: 'VAULTED', customer: { id: 'C9' } } } } }, purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { value: '12.34', currency_code: 'USD' } }] } }] }, 201);
      if (url.endsWith('/NOPE/capture')) return ok({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] }, 422);
      return ok({}, 500);
    };
    const pp = new PayPalFundingProvider({ clientId: 'cid', clientSecret: 'sec', environment: 'sandbox' }, fake);
    const o = await pp.createOrder({ amountMinor: 1_234n, currency: 'USD', reference: 'F1', description: 'fund', saveForAllowance: true, returnUrl: 'http://x/r', cancelUrl: 'http://x/c', requestId: 'req1' });
    expect(o).toEqual({ orderId: 'ORD1', approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORD1' });
    const create = JSON.parse(calls[1].init.body);
    expect(calls[1].url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders');
    expect(calls[1].init.headers['paypal-request-id']).toBe('req1');
    expect(create).toMatchObject({ intent: 'CAPTURE', purchase_units: [{ custom_id: 'F1', amount: { currency_code: 'USD', value: '12.34' } }] });
    expect(create.payment_source.paypal.experience_context).toMatchObject({ return_url: 'http://x/r', cancel_url: 'http://x/c', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' });
    expect(create.payment_source.paypal.attributes.vault).toMatchObject({ store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT' });
    expect(await pp.captureOrder('ORD1', 'cap1')).toEqual({ status: 'COMPLETED', captureId: 'CAP1', amountMinor: 1_234n, currency: 'USD', vault: { id: 'V123', customerId: 'C9' } });
    expect(await pp.captureOrder('NOPE', 'cap2')).toEqual({ status: 'NOT_APPROVED', reason: 'ORDER_NOT_APPROVED' });
    expect(await pp.chargeSaved({ vaultId: 'V123', amountMinor: 2_000n, currency: 'USD', reference: 'R', description: 'allowance', requestId: 'a1' })).toMatchObject({ status: 'COMPLETED', captureId: 'CAP2', orderId: 'ORD2' });
    expect(calls.filter((c) => c.url.endsWith('/oauth2/token'))).toHaveLength(1);   // token cached
  });

  it('an app without Vault: the order is created without saving PayPal (once refused, never asked again)', async () => {
    const bodies: any[] = [], ids: string[] = [];
    const fake: any = async (url: string, init: any) => {
      const ok = (j: unknown, status = 200) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => j, text: async () => JSON.stringify(j) });
      if (url.endsWith('/v1/oauth2/token')) return ok({ access_token: 'tok', expires_in: 3600 });
      const b = JSON.parse(init.body); bodies.push(b); ids.push(init.headers['paypal-request-id']);
      if (b.payment_source.paypal.attributes?.vault) return ok({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE' }] }, 422);
      return ok({ id: 'ORD' + bodies.length, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://pp/approve' }] }, 201);
    };
    const pp = new PayPalFundingProvider({ clientId: 'cid', clientSecret: 'sec', environment: 'sandbox' }, fake);
    const req = { amountMinor: 4_000n, currency: 'USD', reference: 'F1', description: 'seed', saveForAllowance: true, returnUrl: 'http://x/r', cancelUrl: 'http://x/c', requestId: 'req1' };
    expect(pp.vaultAvailable).toBeNull();
    expect(await pp.createOrder(req)).toEqual({ orderId: 'ORD2', approveUrl: 'https://pp/approve', vaultSkipped: 'PAYPAL_VAULT_NOT_ENABLED' });
    expect(ids).toEqual(['req1', 'req1:novault']);                               // a fresh request id for the retry
    expect(pp.vaultAvailable).toBe(false);
    expect(await pp.createOrder({ ...req, requestId: 'req2' })).toMatchObject({ vaultSkipped: 'PAYPAL_VAULT_NOT_ENABLED' });
    expect(bodies).toHaveLength(3);                                              // no second refused attempt
    expect(bodies[2].payment_source.paypal.attributes).toBeUndefined();
    // Other 422s still fail loudly; PAYPAL_VAULT=0 skips the attempt from the start.
    const off = new PayPalFundingProvider({ clientId: 'cid', clientSecret: 'sec', environment: 'sandbox', vault: false }, fake);
    expect(await off.createOrder({ ...req, requestId: 'req3' })).toMatchObject({ orderId: 'ORD4', vaultSkipped: 'PAYPAL_VAULT_NOT_ENABLED' });
    expect(await off.createOrder({ ...req, saveForAllowance: false, requestId: 'req4' })).toEqual({ orderId: 'ORD5', approveUrl: 'https://pp/approve' });
  });
});
