import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AgentWalletService } from '../src/services/AgentWalletService';
import { AgentDevService } from '../src/agentdev/AgentDevService';
import { MerchantService } from '../src/merchant/MerchantService';
import { signRequest, verifyEvent, verifyRequest } from '../src/merchant/signing';
import { createTestDb, TestDb } from './harness';

const USD = 'USD';
const SECRET = 'bazaar-test-secret-0123456789';
let db: TestDb;
let prisma: PrismaClient;
let wallet: AgentWalletService;
let dev: AgentDevService;
let ms: MerchantService;

beforeEach(async () => {
  db = await createTestDb();
  prisma = db.prisma;
  wallet = new AgentWalletService(prisma);
  dev = new AgentDevService(prisma, wallet);
  ms = new MerchantService(prisma, wallet, dev.score, [
    { id: 'agentbazaar', secret: SECRET, webhookUrl: 'http://bazaar.test/v1/paypali/webhooks' },
    { id: 'othershop', secret: 'other-secret-0123456789' },
  ]);
});
afterEach(async () => db.close());

/** A funded, developed buyer agent with bazaar.purchase granted and a grant for agentbazaar. */
async function buyer(opts: { fund?: bigint; develop?: boolean; capability?: boolean; max?: bigint } = {}) {
  const owner = await prisma.owner.create({ data: { email: `o_${randomUUID()}@example.com` } });
  const agent = await prisma.agent.create({ data: { ownerId: owner.id, name: 'buyer' } });
  if ((opts.fund ?? 100_000n) > 0n) await wallet.receive({ agentId: agent.id, amountMinor: opts.fund ?? 100_000n, currency: USD, idempotencyKey: randomUUID() });
  if (opts.develop !== false) await dev.develop(owner.id, agent.id);
  if (opts.develop !== false && opts.capability !== false) await dev.skills.grantCapability(owner.id, agent.id, 'bazaar.purchase', 'HIGH');
  const grant = await ms.createGrant(owner.id, agent.id, { merchantId: 'agentbazaar', maxMinor: opts.max ?? 10_000n, currency: USD });
  return { ownerId: owner.id, agentId: agent.id, grantId: grant.grantId };
}

const chargeIn = (grantId: string, o: Partial<{ amountMinor: bigint; key: string; intent: string; conf: number }> = {}) => ({
  grantId, amountMinor: o.amountMinor ?? 2_800n, currency: USD, idempotencyKey: o.key ?? `bz:${randomUUID()}`,
  reference: 'sf-0152', score: { intentKey: o.intent ?? 'bazaar:sf-0152', confidencePct: o.conf ?? 80 },
});

describe('Merchant Connect: Score-gated charges', () => {
  it('charges through a grant: money to settlement, stake OPEN, bond held', async () => {
    const b = await buyer();
    const r = await ms.charge('agentbazaar', chargeIn(b.grantId));
    expect(r.status).toBe('PAID');
    const stake = await prisma.scoreStake.findUnique({ where: { id: r.stakeId! } });
    expect(stake!.status).toBe('OPEN');
    expect(stake!.capability).toBe('bazaar.purchase');
    expect(await wallet.getBalance(await ms.settlementAgent('agentbazaar'), USD)).toBe(2_800n);
    expect(await wallet.getReserved(b.agentId, USD)).toBe(BigInt(stake!.lockedPoints));
    expect((await ms.getGrant('agentbazaar', b.grantId)).usedMinor).toBe(2_800n);
  });

  it('is idempotent per merchant key and rejects key reuse for a different request', async () => {
    const b = await buyer();
    const input = chargeIn(b.grantId);
    const a = await ms.charge('agentbazaar', input);
    const again = await ms.charge('agentbazaar', input);
    expect(again.replayed).toBe(true);
    expect(again.chargeId).toBe(a.chargeId);
    expect(await wallet.getBalance(await ms.settlementAgent('agentbazaar'), USD)).toBe(2_800n);
    await expect(ms.charge('agentbazaar', { ...input, amountMinor: 1n })).rejects.toThrow('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
  });

  it('declines an undeveloped agent or one without bazaar.purchase, and releases the grant reservation', async () => {
    const u = await buyer({ develop: false });
    const r1 = await ms.charge('agentbazaar', chargeIn(u.grantId));
    expect(r1.status).toBe('DECLINED');
    expect(r1.reasons).toContain('AGENT_NOT_DEVELOPED');
    expect((await ms.getGrant('agentbazaar', u.grantId)).usedMinor).toBe(0n);

    const c = await buyer({ capability: false });
    const r2 = await ms.charge('agentbazaar', chargeIn(c.grantId));
    expect(r2.reasons).toContain('CAPABILITY_NOT_GRANTED');
    expect(await wallet.getBalance(c.agentId, USD)).toBe(100_000n);
  });

  it('enforces the grant: limit, revocation, and merchant isolation', async () => {
    const b = await buyer({ max: 3_000n });
    expect((await ms.charge('agentbazaar', chargeIn(b.grantId, { amountMinor: 3_001n }))).reasons).toEqual(['GRANT_LIMIT_EXCEEDED']);
    expect((await ms.charge('othershop', chargeIn(b.grantId))).reasons).toEqual(['GRANT_NOT_FOUND']);
    await expect(ms.getGrant('othershop', b.grantId)).rejects.toThrow('GRANT_NOT_FOUND');
    await ms.revokeGrant(b.ownerId, b.grantId);
    expect((await ms.charge('agentbazaar', chargeIn(b.grantId))).reasons).toContain('GRANT_REVOKED');
  });

  it('declines when the agent cannot cover price + score bond', async () => {
    const b = await buyer({ fund: 2_850n });
    const r = await ms.charge('agentbazaar', chargeIn(b.grantId));
    expect(r.reasons).toContain('INSUFFICIENT_FUNDS_FOR_BOND');
    expect(await wallet.getBalance(b.agentId, USD)).toBe(2_850n);
  });

  it('settles the purchase stake from the attested outcome: confirm wins, dispute forfeits', async () => {
    const b = await buyer();
    const good = await ms.charge('agentbazaar', chargeIn(b.grantId, { intent: 'goal-a' }));
    const w = await ms.reportOutcome('agentbazaar', good.chargeId!, { success: true, evidence: { run_id: 'run_1', verdict: 'confirm' } });
    expect(w.status).toBe('WON');
    expect(await wallet.getReserved(b.agentId, USD)).toBe(0n);

    const bad = await ms.charge('agentbazaar', chargeIn(b.grantId, { intent: 'goal-b', conf: 90 }));
    const l = await ms.reportOutcome('agentbazaar', bad.chargeId!, { success: false, evidence: { verdict: 'dispute' } });
    expect(l.status).toBe('LOST');
    expect(l.forfeitedMinor).toBeGreaterThan(0n);
    const again = await ms.reportOutcome('agentbazaar', bad.chargeId!, { success: true });
    expect(again.replayed).toBe(true);
    await expect(ms.reportOutcome('othershop', bad.chargeId!, { success: true })).rejects.toThrow('CHARGE_NOT_FOUND');
  });

  it('refunds a paid charge exactly once: money back, grant restored, stake settled as a failure', async () => {
    const b = await buyer();
    const c = await ms.charge('agentbazaar', chargeIn(b.grantId, { intent: 'never-delivered' }));
    const settle = await ms.settlementAgent('agentbazaar');
    const [r1, r2] = await Promise.all([ms.refund('agentbazaar', c.chargeId!, 'non_delivery'), ms.refund('agentbazaar', c.chargeId!, 'non_delivery')]);
    expect([r1.status, r2.status]).toEqual(['REFUNDED', 'REFUNDED']);
    expect(await wallet.getBalance(settle, USD)).toBe(0n);
    expect((await ms.getGrant('agentbazaar', b.grantId)).usedMinor).toBe(0n);
    const stake = await prisma.scoreStake.findUnique({ where: { id: c.stakeId! } });
    expect(stake!.status).toBe('LOST');
    expect(await wallet.getReserved(b.agentId, USD)).toBe(0n);
    // the price comes back; only the bond share the failed stake forfeits is lost
    const forfeited = [r1, r2].reduce((t, r) => t + (r.stake?.forfeitedMinor ?? 0n), 0n);
    expect(forfeited).toBeGreaterThan(0n);
    expect(await wallet.getBalance(b.agentId, USD)).toBe(100_000n - forfeited);
    const again = await ms.refund('agentbazaar', c.chargeId!);
    expect(again.replayed).toBe(true);
    const events = await prisma.merchantEvent.findMany({ where: { type: 'charge.refunded' } });
    expect(events).toHaveLength(1);
    await expect(ms.refund('othershop', c.chargeId!)).rejects.toThrow('CHARGE_NOT_FOUND');
    const nb = await buyer({ capability: false });
    const declined = await ms.charge('agentbazaar', chargeIn(nb.grantId));
    expect(declined.status).toBe('DECLINED');
    await expect(ms.refund('agentbazaar', declined.chargeId!)).rejects.toThrow('CHARGE_NOT_REFUNDABLE');
  });

  it('pays vendors out of the settlement account, idempotently', async () => {
    const b = await buyer();
    await ms.charge('agentbazaar', chargeIn(b.grantId));
    const vOwner = await prisma.owner.create({ data: { email: `v_${randomUUID()}@example.com` } });
    const vendor = await prisma.agent.create({ data: { ownerId: vOwner.id, name: 'vendor' } });
    const p = { toAgentId: vendor.id, amountMinor: 2_520n, currency: USD, idempotencyKey: 'payout:rc_1' };
    await ms.payout('agentbazaar', p);
    expect((await ms.payout('agentbazaar', p)).replayed).toBe(true);
    expect(await wallet.getBalance(vendor.id, USD)).toBe(2_520n);
    expect((await ms.balance('agentbazaar', USD)).availableMinor).toBe(280n);
    await expect(ms.payout('agentbazaar', { ...p, idempotencyKey: 'payout:rc_2', amountMinor: 10_000n })).rejects.toThrow('INSUFFICIENT_FUNDS');
  });

  it('pushes grant.revoked as a signed webhook and retries failures with backoff', async () => {
    const b = await buyer();
    await ms.revokeGrant(b.ownerId, b.grantId);
    const seen: Array<{ url: string; ok: boolean; type: string }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      const body = String(init.body);
      seen.push({ url, ok: verifyEvent(SECRET, h['x-paypali-signature'], h['x-paypali-event-id'], body), type: JSON.parse(body).type });
      return new Response('{}', { status: seen.length === 1 ? 503 : 200 });
    }) as unknown as typeof fetch;
    expect(await ms.deliverDue(fakeFetch)).toEqual({ delivered: 0, failed: 1 });
    await prisma.merchantEvent.updateMany({ data: { availableAt: new Date(0) } }); // fast-forward the backoff
    expect(await ms.deliverDue(fakeFetch)).toEqual({ delivered: 1, failed: 0 });
    expect(seen.every((s) => s.ok && s.type === 'grant.revoked')).toBe(true);
  });
});

describe('Merchant Connect signatures', () => {
  it('accepts a fresh correct signature and rejects stale or tampered ones', () => {
    const ts = Date.now();
    const sig = signRequest(SECRET, ts, 'POST', '/api/merchant/charges', '{"a":1}');
    const h = { ts: String(ts), sig };
    expect(verifyRequest(SECRET, h, 'POST', '/api/merchant/charges', '{"a":1}')).toBe('OK');
    expect(verifyRequest(SECRET, h, 'POST', '/api/merchant/charges', '{"a":2}')).toBe('BAD_SIGNATURE');
    expect(verifyRequest(SECRET, h, 'POST', '/api/merchant/payouts', '{"a":1}')).toBe('BAD_SIGNATURE');
    expect(verifyRequest(SECRET, h, 'POST', '/api/merchant/charges', '{"a":1}', ts + 6 * 60_000)).toBe('STALE_TIMESTAMP');
    expect(verifyRequest('wrong-secret-xxxxxxxx', h, 'POST', '/api/merchant/charges', '{"a":1}')).toBe('BAD_SIGNATURE');
  });
});
