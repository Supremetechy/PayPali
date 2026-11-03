import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { AgentWalletService } from '../src/services/AgentWalletService';
import { AgentDevService } from '../src/agentdev/AgentDevService';
import { MerchantService } from '../src/merchant/MerchantService';
import { IdentityIssuer } from '../src/bazaar/IdentityIssuer';
import { KycService } from '../src/bazaar/KycService';
import { PAYPAL_SCOPES, PayPalIdentityProvider, SandboxKycProvider } from '../src/bazaar/kycProviders';
import { createTestDb, TestDb } from './harness';

let db: TestDb, prisma: PrismaClient, issuer: IdentityIssuer, sandbox: SandboxKycProvider, kyc: KycService;
const pub = () => generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const PAYER = 'QYR5Z8XDVJNXQ';

beforeEach(async () => {
  db = await createTestDb();
  prisma = db.prisma;
  issuer = IdentityIssuer.generate('paypali').issuer;
  sandbox = new SandboxKycProvider('http://paypali.test');
  kyc = new KycService(prisma, issuer, sandbox, { fingerprintKey: randomBytes(32) });
});
afterEach(async () => db.close());

async function owner() {
  const o = await prisma.owner.create({ data: { email: `o_${randomUUID()}@example.com` } });
  const a = await prisma.agent.create({ data: { ownerId: o.id, name: 'payout' } });
  return { ownerId: o.id, agentId: a.id };
}
const stateOf = (s: any) => String(s.url).split('/').pop()!;
async function verify(ownerId: string, payerId: string, outcome = 'approve') {
  const s: any = await kyc.start(ownerId);
  return kyc.complete(stateOf(s), { outcome, payerId });
}

describe('KYC via PayPal: dev → kyc assurance', () => {
  it('without KYC an owner gets an account-level dev credential; with a verified PayPal account a person-level kyc credential', async () => {
    const o = await owner(), key = pub();
    const dev = await kyc.credentialFor(o.ownerId, key);
    expect(dev.body).toMatchObject({ assurance: 'dev', method: 'account', subject: issuer.accountSubject(o.ownerId), principal_pub: key });
    expect(issuer.verifyOwn(dev)).toBe(true);

    const s: any = await kyc.start(o.ownerId);
    expect(s.url).toMatch(/^http:\/\/paypali\.test\/kyc\/sandbox\/ksb_/);
    expect((await kyc.status(o.ownerId)).lastSession!.status).toBe('PENDING');
    expect((await kyc.complete(stateOf(s), { outcome: 'approve', payerId: PAYER })).status).toBe('VERIFIED');

    expect(await kyc.status(o.ownerId)).toMatchObject({ verified: true, assurance: 'kyc', method: 'sandbox', revoked: false });
    const k = await kyc.credentialFor(o.ownerId, key);
    const person = await prisma.kycPerson.findUniqueOrThrow({ where: { ownerId: o.ownerId } });
    expect(k.body).toMatchObject({ assurance: 'kyc', method: 'sandbox', subject: issuer.personSubject(person.id) });
    expect(k.body.exp).toBeLessThanOrEqual(person.expiresAt.getTime());
    expect((await kyc.start(o.ownerId) as any).alreadyVerified).toBe(true);
  });

  it('stores no PayPal identifiers: only a keyed fingerprint of the payer id', async () => {
    const o = await owner();
    await verify(o.ownerId, PAYER);
    const dump = JSON.stringify(await Promise.all([prisma.kycPerson.findMany(), prisma.kycFingerprint.findMany(), prisma.kycSession.findMany()]));
    expect(dump).not.toContain(PAYER);
    const fps = await prisma.kycFingerprint.findMany();
    expect(fps.map((f) => f.kind)).toEqual(['paypal_payer_id']);
    expect(/^[0-9a-f]{64}$/.test(fps[0].hash)).toBe(true);
  });

  it('an unverified PayPal account does not reach kyc, and can retry in the same session', async () => {
    const o = await owner();
    const s: any = await kyc.start(o.ownerId);
    expect((await kyc.complete(stateOf(s), { outcome: 'unverified', payerId: PAYER })).status).toBe('REQUIRES_INPUT');
    expect((await kyc.status(o.ownerId))).toMatchObject({ assurance: 'dev', lastSession: { lastError: 'paypal_account_not_verified' } });
    const again: any = await kyc.start(o.ownerId);
    expect(again.resumed).toBe(true);
    expect(again.url).toBe(s.url);
    expect((await kyc.complete(stateOf(s), { outcome: 'approve', payerId: PAYER })).status).toBe('VERIFIED');
    expect((await kyc.complete(stateOf(s), { outcome: 'approve', payerId: 'SOMEONEELSE' })).replayed).toBe(true);   // state is single-use
  });

  it('one PayPal account cannot verify two PayPali owners; the same owner can re-verify', async () => {
    const a = await owner(), b = await owner();
    expect((await verify(a.ownerId, PAYER)).status).toBe('VERIFIED');
    expect((await verify(b.ownerId, ' qyr5z8xdvjnxq ')).status).toBe('DUPLICATE');   // case/space-insensitive
    expect(await kyc.status(b.ownerId)).toMatchObject({ verified: false, assurance: 'dev', lastSession: { lastError: 'paypal_account_already_verified_on_another_owner' } });
    const p1 = await prisma.kycPerson.findUniqueOrThrow({ where: { ownerId: a.ownerId } });
    await prisma.kycPerson.update({ where: { id: p1.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await kyc.credentialFor(a.ownerId, pub())).body.assurance).toBe('dev');   // expired → back to dev
    expect((await verify(a.ownerId, PAYER)).status).toBe('VERIFIED');
    expect((await prisma.kycPerson.findUniqueOrThrow({ where: { ownerId: a.ownerId } })).id).toBe(p1.id);
  });

  it('unknown or foreign state values are refused', async () => {
    await expect(kyc.complete('ksb_nope', { outcome: 'approve', payerId: PAYER })).rejects.toThrow('KYC_SESSION_NOT_FOUND');
  });

  it('the sandbox refuses to run in production', () => {
    expect(() => new SandboxKycProvider('x', { NODE_ENV: 'production' } as any)).toThrow('KYC_SANDBOX_NOT_ALLOWED_IN_PRODUCTION');
  });
});

describe('Revocation', () => {
  it('revokes every subject, publishes signed docs, pushes them, and stops issuing', async () => {
    const pushed: any[] = [];
    kyc = new KycService(prisma, issuer, sandbox, { fingerprintKey: randomBytes(32), revocationSinks: ['http://bazaar.test'],
      fetch: (async (url: string, init: any) => { pushed.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); }) as any });
    const o = await owner();
    await verify(o.ownerId, PAYER);
    expect(await kyc.revoke(o.ownerId, 'chargeback fraud')).toEqual({ revoked: 2, pushed: 2 });
    expect(pushed[0].url).toBe('http://bazaar.test/v1/identity/revocations');
    const feed = await kyc.revocationFeed();
    expect(feed.revocations).toHaveLength(2);
    expect(feed.revocations.every((d: any) => issuer.verifyOwn(d) && d.body.kind === 'revocation')).toBe(true);
    await expect(kyc.credentialFor(o.ownerId, pub())).rejects.toThrow('IDENTITY_REVOKED');
    await expect(kyc.start(o.ownerId)).rejects.toThrow('IDENTITY_REVOKED');
    expect(await kyc.status(o.ownerId)).toMatchObject({ revoked: true, assurance: null });
    expect((await kyc.revoke(o.ownerId, 'again')).revoked).toBe(2);   // idempotent
    expect((await kyc.revocationFeed()).revocations).toHaveLength(2);
  });
});

describe('Payout bindings', () => {
  it('binds a vendor key to an owned agent, and PayPali re-checks it on payout', async () => {
    const o = await owner(), other = await owner(), vendorPub = pub();
    await expect(kyc.payoutBinding(o.ownerId, other.agentId, vendorPub)).rejects.toThrow('AGENT_NOT_OWNED');
    const b = await kyc.payoutBinding(o.ownerId, o.agentId, vendorPub);
    expect(b.body).toMatchObject({ kind: 'payout_binding', vendor_pub: vendorPub, paypali_agent_id: o.agentId, subject: issuer.accountSubject(o.ownerId) });
    expect(await kyc.verifyPayoutBinding(b, o.agentId)).toBeNull();
    expect(await kyc.verifyPayoutBinding(b, other.agentId)).toBe('PAYOUT_BINDING_AGENT_MISMATCH');
    expect(await kyc.verifyPayoutBinding({ ...b, body: { ...b.body, paypali_agent_id: other.agentId } }, other.agentId)).toBe('PAYOUT_BINDING_INVALID');
    expect(await kyc.verifyPayoutBinding(IdentityIssuer.generate('paypali').issuer.issuePayoutBinding({ subject: b.body.subject, vendorPub, agentId: o.agentId }), o.agentId)).toBe('PAYOUT_BINDING_INVALID');
    expect(await kyc.verifyPayoutBinding(null, o.agentId)).toBe('PAYOUT_BINDING_REQUIRED');
    await verify(o.ownerId, PAYER);   // the owner's subject is now the PayPal-verified person: re-issue bindings
    expect(await kyc.verifyPayoutBinding(b, o.agentId)).toBe('PAYOUT_BINDING_SUBJECT_CHANGED');
    const b2 = await kyc.payoutBinding(o.ownerId, o.agentId, vendorPub);
    expect(await kyc.verifyPayoutBinding(b2, o.agentId)).toBeNull();
    await kyc.revoke(o.ownerId, 'fraud');
    expect(await kyc.verifyPayoutBinding(b2, o.agentId)).toBe('PAYOUT_BINDING_REVOKED');
  });

  it('MerchantService refuses payouts without a valid binding when required', async () => {
    const wallet = new AgentWalletService(prisma), dev = new AgentDevService(prisma, wallet);
    const ms = new MerchantService(prisma, wallet, dev.score, [{ id: 'agentbazaar', secret: 'test-secret-0123456789abcdef' }]);
    ms.payoutBindingCheck = (b, to) => kyc.verifyPayoutBinding(b as any, to);
    ms.requirePayoutBinding = true;
    await wallet.receive({ agentId: await ms.settlementAgent('agentbazaar'), amountMinor: 5_000n, currency: 'USD', idempotencyKey: randomUUID() });
    const o = await owner(), vendorPub = pub();
    const p = { toAgentId: o.agentId, amountMinor: 1_000n, currency: 'USD', idempotencyKey: 'payout:rc_1' };
    await expect(ms.payout('agentbazaar', p)).rejects.toThrow('PAYOUT_BINDING_REQUIRED');
    const intruder = await owner();
    await expect(ms.payout('agentbazaar', { ...p, binding: await kyc.payoutBinding(intruder.ownerId, intruder.agentId, vendorPub) })).rejects.toThrow('PAYOUT_BINDING_AGENT_MISMATCH');
    const ok = await ms.payout('agentbazaar', { ...p, binding: await kyc.payoutBinding(o.ownerId, o.agentId, vendorPub) });
    expect(ok.replayed).toBe(false);
    expect(await wallet.getBalance(o.agentId, 'USD')).toBe(1_000n);
  });
});

describe('Log in with PayPal adapter', () => {
  const CFG = { clientId: 'AppClientId', clientSecret: 'AppSecret', redirectUri: 'https://paypali.example/api/kyc/paypal/callback' };
  function paypalMock(userinfo: Record<string, unknown>, opts: { v11Fails?: boolean; tokenStatus?: number } = {}) {
    const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: string }> = [];
    const f = (async (url: string, init: any = {}) => {
      calls.push({ method: init.method ?? 'GET', url, headers: init.headers ?? {}, body: init.body });
      const u = new URL(url);
      if (u.pathname === '/v1/oauth2/token') {
        if (opts.tokenStatus) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: opts.tokenStatus });
        return new Response(JSON.stringify({ access_token: 'A21AA-token', token_type: 'Bearer', expires_in: 28800 }), { status: 200 });
      }
      if (u.pathname === '/v1/identity/oauth2/userinfo') {
        if (opts.v11Fails) return new Response(JSON.stringify({ name: 'INVALID_REQUEST' }), { status: 400 });
        return new Response(JSON.stringify(userinfo), { status: 200 });
      }
      if (u.pathname === '/v1/identity/openidconnect/userinfo') return new Response(JSON.stringify(userinfo), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    return { calls, f };
  }

  it('sends the owner to PayPal, exchanges the code server-side, and links a verified account by payer id', async () => {
    const m = paypalMock({ user_id: 'https://www.paypal.com/webapps/auth/identity/user/abc', payer_id: PAYER, verified_account: true, name: 'Jenny Rosen' });
    kyc = new KycService(prisma, issuer, new PayPalIdentityProvider({ ...CFG, env: 'sandbox', fetch: m.f }), { fingerprintKey: randomBytes(32) });
    const o = await owner();
    const s: any = await kyc.start(o.ownerId);
    const u = new URL(s.url);
    expect(u.origin + u.pathname).toBe('https://www.sandbox.paypal.com/signin/authorize');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: 'AppClientId', response_type: 'code', redirect_uri: CFG.redirectUri, scope: PAYPAL_SCOPES.join(' ') });
    const state = u.searchParams.get('state')!;
    expect(state).toMatch(/^ppl_[0-9a-f]{40}$/);
    expect(u.searchParams.toString()).not.toContain('AppSecret');

    expect((await kyc.complete(state, { code: 'C21AAauthcode' })).status).toBe('VERIFIED');
    const tok = m.calls.find((c) => c.url.endsWith('/v1/oauth2/token'))!;
    expect(tok.url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
    expect(tok.headers.authorization).toBe('Basic ' + Buffer.from('AppClientId:AppSecret').toString('base64'));
    expect(new URLSearchParams(tok.body)).toEqual(new URLSearchParams({ grant_type: 'authorization_code', code: 'C21AAauthcode' }));
    const ui = m.calls.find((c) => c.url.includes('/userinfo'))!;
    expect(ui.url).toBe('https://api-m.sandbox.paypal.com/v1/identity/oauth2/userinfo?schema=paypalv1.1');
    expect(ui.headers.authorization).toBe('Bearer A21AA-token');
    expect((await kyc.credentialFor(o.ownerId, pub())).body).toMatchObject({ assurance: 'kyc', method: 'paypal_verified_account' });
    expect((await kyc.complete(state, { code: 'C21AAauthcode' })).replayed).toBe(true);   // a replayed callback changes nothing
    expect(JSON.stringify(await prisma.kycFingerprint.findMany())).not.toContain(PAYER);
  });

  it('refuses unverified accounts, missing payer ids, cancellations and bad codes; falls back to the OpenID userinfo endpoint', async () => {
    const run = async (ui: Record<string, unknown>, params: Record<string, string>, opts?: { v11Fails?: boolean; tokenStatus?: number }) => {
      const m = paypalMock(ui, opts);
      kyc = new KycService(prisma, issuer, new PayPalIdentityProvider({ ...CFG, fetch: m.f }), { fingerprintKey: randomBytes(32) });
      const o = await owner(), s: any = await kyc.start(o.ownerId);
      const r = await kyc.complete(new URL(s.url).searchParams.get('state')!, params);
      return { r, st: await kyc.status(o.ownerId), calls: m.calls };
    };
    const unverified = await run({ payer_id: PAYER, verified_account: false }, { code: 'c' });
    expect(unverified.r.status).toBe('REQUIRES_INPUT');
    expect(unverified.st.lastSession!.lastError).toBe('paypal_account_not_verified');
    expect((await run({ verified_account: true }, { code: 'c' })).st.lastSession!.lastError).toBe('paypal_payer_id_missing');
    expect((await run({}, { error: 'access_denied' })).r.status).toBe('CANCELED');
    expect((await run({}, { code: 'expired' }, { tokenStatus: 400 })).st.lastSession!.lastError).toBe('paypal_token_invalid_grant');
    const fb = await run({ payer_id: PAYER + 'X', verified_account: 'true' }, { code: 'c' }, { v11Fails: true });
    expect(fb.r.status).toBe('VERIFIED');
    expect(fb.calls.some((c) => c.url.endsWith('/v1/identity/openidconnect/userinfo?schema=openid'))).toBe(true);
  });

  it('uses the live hosts when PAYPAL_ENV=live, and refuses an incomplete configuration', () => {
    const p = new PayPalIdentityProvider({ ...CFG, env: 'live' });
    expect(p.authorizeUrl('ppl_x')).toMatch(/^https:\/\/www\.paypal\.com\/signin\/authorize\?/);
    expect(() => new PayPalIdentityProvider({ clientId: 'x', clientSecret: '', redirectUri: 'y' })).toThrow('PAYPAL_IDENTITY_CONFIG_INCOMPLETE');
  });
});
