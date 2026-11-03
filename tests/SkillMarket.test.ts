import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { AgentWalletService } from '../src/services/AgentWalletService';
import { AgentDevService } from '../src/agentdev/AgentDevService';
import { GasService } from '../src/market/GasService';
import { makePortalRegistry } from '../src/market/portals';
import { SkillMarket, signSkill, reservedBrand } from '../src/skills/SkillMarket';
import { GasPriceOracle, nextPrice, DEFAULT_GAS_FLOAT } from '../src/market/GasPrice';
import { registerDemoSkills, seedDemoSkills } from '../src/skills/demoSkills';
import { createTestDb, TestDb } from './harness';

let db: TestDb, prisma: PrismaClient, wallet: AgentWalletService, dev: AgentDevService, gas: GasService, market: SkillMarket;
beforeEach(async () => {
  db = await createTestDb(); prisma = db.prisma;
  wallet = new AgentWalletService(prisma); dev = new AgentDevService(prisma, wallet);
  gas = new GasService(prisma, wallet, dev.score, makePortalRegistry({ sandbox: true }));
  market = new SkillMarket({ prisma, wallet, dev, gas, allowBuiltin: true, allowInsecureEndpoints: true, fetchFn: (u, i) => fetch(u, i) as any });
  registerDemoSkills(market);
});
afterEach(async () => db.close());

async function agentFor(email: string, name: string, fund = 0n) {
  const o = await prisma.owner.upsert({ where: { email }, update: {}, create: { email } });
  const a = await prisma.agent.create({ data: { ownerId: o.id, name } });
  await wallet.ensureAccount(a.id, 'USD');
  if (fund) await wallet.receive({ agentId: a.id, amountMinor: fund, currency: 'USD', idempotencyKey: randomUUID() });
  return { ownerId: o.id, agentId: a.id };
}
const bal = (id: string) => wallet.getBalance(id, 'USD');
const agentId = async (name: string) => (await prisma.agent.findFirstOrThrow({ where: { name } })).id;

describe('Skills sold agent to agent, priced in Gas', () => {
  it('the worked example: one call of Find an episode costs 160 Gas and pays four parties', async () => {
    await seedDemoSkills(market, { agentFor: (e, n) => agentFor(e, n) });
    const me = await agentFor('me@example.com', 'My agent', 5_000n);
    const lic = await market.license(me.agentId, { skill: 'find-episode' }, { ownerId: me.ownerId });
    expect(lic.license).toMatchObject({ mode: 'PER_CALL', status: 'ACTIVE', licensor: { name: 'Episode Finder' } });

    const q = await market.quote(me.agentId, 'find-episode');
    expect(q.blockers).toEqual([]);
    expect(q.lines.map((l) => [l.role, l.agentName, l.gas])).toEqual([
      ['seller', 'Episode Finder', 108], ['royalty', 'Scene Reader', 12], ['upstream', 'Northwind Streaming', 30], ['network', 'PayPali network fees', 10],
    ]);
    expect(q).toMatchObject({ totalGas: 160, payNowGas: 160, amountMinor: 16n });

    const r = await market.invoke(me.agentId, { skill: 'find-episode', input: { show: 'The Long Orbit', description: 'they find a stowaway cat on the ship' }, confidencePct: 80 });
    expect(r.status).toBe('SETTLED');
    expect(r.output).toMatchObject({ found: true, season: 1, episode: 3, title: 'Quiet Hours' });
    expect(await bal(me.agentId)).toBe(5_000n - 16n);                               // bond back on a win
    expect(await bal(await agentId('Episode Finder'))).toBe(10n);                  // 108 Gas = 10.8¢: 10¢ now, 0.8¢ carried
    expect(await bal(await agentId('Scene Reader'))).toBe(1n);
    expect(await bal(await agentId('Northwind Streaming'))).toBe(3n);
    await market.invoke(me.agentId, { skill: 'find-episode', input: { show: 'Harbor Lights', description: 'storm during a wedding' }, confidencePct: 80 });
    expect(await bal(await agentId('Episode Finder'))).toBe(21n);                  // 216 Gas = 21.6¢: the carry pays out
    expect((await prisma.license.findUniqueOrThrow({ where: { id: lic.license.id } })).callsUsed).toBe(2);
    // Episode Finder's own license to Northwind's catalog was used too.
    const up = await prisma.license.findFirstOrThrow({ where: { licenseeAgentId: await agentId('Episode Finder'), skillRef: 'skill:northwind-catalog-search' } });
    expect(up.callsUsed).toBe(2);
  });

  it('a bundle is paid up front into escrow and released per call; a failed call is refunded and loses the stake', async () => {
    await seedDemoSkills(market, { agentFor: (e, n) => agentFor(e, n) });
    const me = await agentFor('me@example.com', 'My agent', 5_000n);
    const offers = (await market.get('find-episode')).offers;
    const bundle = offers.find((o) => o.mode === 'BUNDLE')!;
    const lic = await market.license(me.agentId, { skill: 'find-episode', offerId: bundle.id }, { ownerId: me.ownerId });
    expect(lic).toMatchObject({ paidGas: 812, amountMinor: 82n });                 // 800 + network 12
    expect(lic.license).toMatchObject({ mode: 'BUNDLE', callsTotal: 10, prepaidGas: 800 });
    const q = await market.quote(me.agentId, 'find-episode');
    expect(q.lines.map((l) => [l.role, l.gas, l.prepaid ?? 0])).toEqual([['seller', 90, 80], ['royalty', 10, 0], ['upstream', 30, 0], ['network', 10, 0]]);
    expect(q.payNowGas).toBe(60);

    const before = await bal(me.agentId);
    const bad = await market.invoke(me.agentId, { skill: 'find-episode', input: { show: 'Nonexistent Show', description: 'anything at all' }, confidencePct: 70 });
    expect(bad).toMatchObject({ status: 'FAILED', reasons: ['SHOW_NOT_IN_CATALOG'], refunded: true });
    expect(bad.settlement!.status).toBe('LOST');
    expect(await bal(me.agentId)).toBeLessThan(before);                             // part of the bond forfeited, the Gas refunded
    expect((await prisma.license.findUniqueOrThrow({ where: { id: lic.license.id } })).prepaidGas).toBe(800);   // nothing released

    const ok = await market.invoke(me.agentId, { skill: 'find-episode', input: { show: 'Kitchen Atlas', description: 'mole with chiles from the market' }, confidencePct: 80 });
    expect(ok).toMatchObject({ status: 'SETTLED', output: { title: 'Oaxaca Mole' } });
    expect(await prisma.license.findUniqueOrThrow({ where: { id: lic.license.id } })).toMatchObject({ prepaidGas: 720, callsUsed: 1 });
    // Revoking returns the unused prepaid Gas (720 Gas = 72¢).
    const b2 = await bal(me.agentId);
    await market.revoke(me.ownerId, lic.license.id);
    expect(await bal(me.agentId)).toBe(b2 + 72n);
  });

  it('selling needs licenses for what you build on; embedding needs a sublicensable one; fees stay within the owner’s maximum', async () => {
    await seedDemoSkills(market, { agentFor: (e, n) => agentFor(e, n) });
    const seller = await agentFor('seller@example.com', 'Copycat', 1_000n);
    const base = { agentId: seller.agentId, name: 'Copy', executor: 'builtin:find-episode', offers: [{ mode: 'PER_CALL' as const, priceGas: 50 }] };
    await expect(market.publish(seller.ownerId, { ...base, slug: 'copy-1', dependencies: [{ skill: 'northwind-catalog-search', use: 'CALL' }] })).rejects.toThrow('DEPENDENCY_NOT_LICENSED:northwind-catalog-search');
    await market.license(seller.agentId, { skill: 'find-episode' }, { ownerId: seller.ownerId });
    await expect(market.publish(seller.ownerId, { ...base, slug: 'copy-2', dependencies: [{ skill: 'find-episode', use: 'EMBED' }] })).rejects.toThrow('DEPENDENCY_NOT_SUBLICENSABLE:find-episode');
    await expect(market.publish(seller.ownerId, { ...base, slug: 'copy-3', offers: [{ mode: 'PER_CALL', priceGas: 5, royaltyBps: 500 }] })).rejects.toThrow('ROYALTY_NEEDS_SUBLICENSABLE');

    const finder = await agentId('Episode Finder');
    await expect(market.setRateCard(finder, { actFeeGas: 150 }, { agent: true })).rejects.toThrow('FEE_ABOVE_OWNER_MAXIMUM');
    await expect(market.setRateCard(finder, { maxFeeGas: 999 }, { agent: true })).rejects.toThrow('ONLY_THE_OWNER_SETS_THE_MAXIMUM');
    expect(await market.setRateCard(finder, { actFeeGas: 60 }, { agent: true })).toMatchObject({ actFeeGas: 60, maxFeeGas: 100 });
    const q = await market.quote(seller.agentId, 'find-episode');
    expect(q.lines[0]).toMatchObject({ role: 'seller', gas: 144 });                 // (100 + 60) less 10% royalty
    expect((await dev.skills.capabilitiesFor(seller.agentId)).map((c: any) => c.capability)).toContain('skill.use');
  });

  it('Give this skill agency: a new agent owns and earns from the skill; the economy view shows holds, sells, earns, spends', async () => {
    await seedDemoSkills(market, { agentFor: (e, n) => agentFor(e, n) });
    const finderOwner = (await prisma.owner.findUniqueOrThrow({ where: { email: 'finder@demo.paypali' } })).id;
    const el = await market.elevate(finderOwner, 'find-episode', { name: 'Episode Finder Pro' });
    expect(el.skill.seller).toMatchObject({ name: 'Episode Finder Pro' });
    expect(el.skill.hasAgency).toBe(true);
    await expect(market.elevate(finderOwner, 'find-episode')).rejects.toThrow('SKILL_ALREADY_HAS_AGENCY');
    // Its upstream licenses moved with it, so it still works.
    const me = await agentFor('me@example.com', 'My agent', 5_000n);
    await market.license(me.agentId, { skill: 'find-episode' }, { ownerId: me.ownerId });
    const r = await market.invoke(me.agentId, { skill: 'find-episode', input: { show: 'The Long Orbit', description: 'dust storm traps them in the rover' }, confidencePct: 75 });
    expect(r).toMatchObject({ status: 'SETTLED', output: { title: 'Red Dust' } });
    expect(await bal(el.agent.id)).toBe(10n);

    const pro = await market.economy(el.agent.id);
    expect(pro.sells.skills.map((s) => s.slug)).toEqual(['find-episode']);
    expect(pro.sells.skills[0].licensees).toBe(1);
    expect(pro.holds.map((h) => h.skillRef).sort()).toEqual(['skill:northwind-catalog-search', 'skill:scene-match']);
    expect(pro.earns).toMatchObject({ skillsGas: 108, byRole: { seller: 108 } });
    const buyer = await market.economy(me.agentId);
    expect(buyer.spends).toMatchObject({ skillsGas: 160, skillsMinor: 16 });
    expect(buyer.holds[0]).toMatchObject({ skillName: 'Find an episode', licensor: { name: 'Episode Finder Pro' } });
    const reader = await market.economy(await agentId('Scene Reader'));
    expect(reader.earns.byRole.royalty).toBe(12);
  });

  it('spending grants and data subscriptions show up as licenses the agent holds', async () => {
    const me = await agentFor('me@example.com', 'My agent', 1_000n);
    const seller = await agentFor('co@example.com', 'Acme agent');
    await prisma.merchantGrant.create({ data: { merchantId: 'agentbazaar', ownerId: me.ownerId, agentId: me.agentId, currency: 'USD', maxMinor: 20_000n, usedMinor: 1_500n } });
    const da = await prisma.dataAgent.create({ data: { slug: 'acme-x', name: 'Acme X', description: '', ownerId: seller.ownerId, agentId: seller.agentId, endpointUrl: 'https://x.test', endpointSecret: 'x' } });
    await prisma.dataSubscription.create({ data: { dataAgentId: da.id, buyerAgentId: me.agentId, ownerId: me.ownerId, monthlyBudgetMinor: 2_000n } });
    const h = await market.holdings(me.agentId);
    expect(h.map((x) => [x.source, x.mode, x.skillName, x.status])).toEqual(expect.arrayContaining([
      ['MERCHANT_GRANT', 'SPENDING_CAP', 'AgentBazaar purchases', 'ACTIVE'], ['DATA_SUBSCRIPTION', 'SUBSCRIPTION', 'Acme X', 'ACTIVE'],
    ]));
    expect(h.find((x) => x.source === 'DATA_SUBSCRIPTION')!.licensor).toMatchObject({ name: 'Acme agent' });
    await market.holdings(me.agentId);
    expect(await prisma.license.count({ where: { licenseeAgentId: me.agentId } })).toBe(2);          // idempotent
  });

  it('a company provider agent: webhook access skill, verified by a signed challenge, paid per call', async () => {
    let secret = '';
    const srv: Server = createServer((req, res) => {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        const ok = req.headers['x-paypali-skill-signature'] === signSkill(secret, String(req.headers['x-paypali-skill-ts']), b);
        const j = JSON.parse(b);
        const out = !ok ? { error: 'bad signature' } : j.type === 'challenge' ? { challenge: j.challenge } : { output: { stock: 42, sku: j.input.sku } };
        const text = JSON.stringify(out);
        res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json', 'x-skill-signature': signSkill(secret, j.call_id, text) }); res.end(text);
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as any).port}/skills`;
    try {
      const co = await agentFor('ops@acme.test', 'Acme Parts');
      const pub = await market.publish(co.ownerId, { agentId: co.agentId, slug: 'acme-stock', name: 'Stock level', kind: 'ACCESS', executor: 'webhook', endpointUrl: url, inputSchema: { type: 'object', required: ['sku'] }, offers: [{ mode: 'PER_CALL', priceGas: 20 }] });
      expect(pub.skill.status).toBe('PAUSED');
      secret = pub.endpointSecret!;
      expect((await market.verifyEndpoint(co.ownerId, 'acme-stock')).status).toBe('ACTIVE');
      const me = await agentFor('me@example.com', 'My agent', 1_000n);
      await market.license(me.agentId, { skill: 'acme-stock' }, { ownerId: me.ownerId });
      expect((await market.invoke(me.agentId, { skill: 'acme-stock', input: {}, confidencePct: 80 })).reasons).toEqual(['INPUT_REQUIRED:sku']);
      const r = await market.invoke(me.agentId, { skill: 'acme-stock', input: { sku: 'B-7' }, confidencePct: 80 });
      expect(r).toMatchObject({ status: 'SETTLED', output: { stock: 42, sku: 'B-7' }, totalGas: 30 });   // 20 + network minimum 10
      secret = 'rotated-elsewhere';
      expect(await market.invoke(me.agentId, { skill: 'acme-stock', input: { sku: 'B-7' }, confidencePct: 80 })).toMatchObject({ status: 'FAILED', refunded: true });
    } finally { srv.close(); }
  });

  it('the Gas price floats with demand, at most 12.5% an epoch, within its bounds', async () => {
    const cfg = { ...DEFAULT_GAS_FLOAT, targetGasPerEpoch: 300 };
    expect(nextPrice(100, 600, cfg)).toBe(113);      // double the target: +12.5%
    expect(nextPrice(100, 0, cfg)).toBe(88);         // idle: −12.5%
    expect(nextPrice(100, 300, cfg)).toBe(100);      // on target: unchanged
    expect(nextPrice(21, 0, cfg)).toBe(20);          // floor
    expect(nextPrice(990, 1_000_000, cfg)).toBe(1000);  // ceiling
    let t = new Date('2026-11-01T00:00:00Z');
    const oracle = new GasPriceOracle(prisma, gas, cfg, () => t);
    await oracle.boot();
    await seedDemoSkills(market, { agentFor: (e, n) => agentFor(e, n) });
    const me = await agentFor('me@example.com', 'My agent', 5_000n);
    await market.license(me.agentId, { skill: 'find-episode' }, { ownerId: me.ownerId });
    t = new Date('2026-11-01T00:10:00Z');
    for (const d of ['stowaway cat', 'storm during the wedding', 'dust storm rover', 'heat shield signal']) {
      await market.invoke(me.agentId, { skill: 'find-episode', input: { show: /cat|heat|dust/.test(d) ? 'The Long Orbit' : 'Harbor Lights', description: d }, confidencePct: 80 });
    }
    await prisma.skillCall.updateMany({ data: { settledAt: new Date('2026-11-01T00:10:00Z') } });
    t = new Date('2026-11-01T01:00:00Z');
    const e1 = await oracle.tick();
    expect(Number(e1!.demandGas)).toBe(640);                                            // 4 calls × 160 Gas
    expect(e1).toMatchObject({ priceMilli: 100, nextPriceMilli: 113 });
    expect(gas.priceMilli).toBe(113);
    expect((await market.quote(me.agentId, 'find-episode')).amountMinor).toBe(19n);    // 160 Gas at $0.00113
    t = new Date('2026-11-01T03:00:00Z');
    await oracle.tick();                                                                 // two quiet epochs
    expect(gas.priceMilli).toBe(Math.round(Math.round(113 * 0.875) * 0.875));
    const v = await oracle.view();
    expect(v).toMatchObject({ floating: true, priceMilli: gas.priceMilli });
    expect(v.history).toHaveLength(3);
    // A restarted server resumes at the last price.
    gas.cfg.gasPriceMilli = 100;
    await new GasPriceOracle(prisma, gas, cfg, () => t).boot();
    expect(gas.priceMilli).toBe(v.priceMilli);
  });

  it('every call settles at its own price; prepaid Gas is released at the price it was bought at', async () => {
    await seedDemoSkills(market, { agentFor: (e, n) => agentFor(e, n) });
    const me = await agentFor('me@example.com', 'My agent', 5_000n);
    const bundle = (await market.get('find-episode')).offers.find((o) => o.mode === 'BUNDLE')!;
    await market.license(me.agentId, { skill: 'find-episode', offerId: bundle.id }, { ownerId: me.ownerId });   // bought at 100
    gas.cfg.gasPriceMilli = 200;                                                                                // Gas doubles
    const r = await market.invoke(me.agentId, { skill: 'find-episode', input: { show: 'Kitchen Atlas', description: 'bread in a clay oven' }, confidencePct: 80 });
    expect(r).toMatchObject({ status: 'SETTLED', priceMilli: 200, payNowGas: 60, amountMinor: 12n });
    // Seller line 90 Gas: 10 paid now at 200 (2¢) + 80 prepaid at 100 (8¢) = 10¢, not 18¢.
    expect(await bal(await agentId('Episode Finder'))).toBe(10n);
    expect((await prisma.skillCall.findFirstOrThrow({ where: { callerAgentId: me.agentId } })).gasPriceMilli).toBe(200);
    const capped = await market.invoke(me.agentId, { skill: 'find-episode', input: { show: 'Kitchen Atlas', description: 'mole' }, confidencePct: 80, maxAmountMinor: 5n });
    expect(capped).toMatchObject({ status: 'DECLINED', reasons: ['PRICE_ABOVE_YOUR_MAXIMUM'] });
  });

  it('sublicensing needs a royalty; listed brands are invitations until they partner', async () => {
    const s = await agentFor('s@example.com', 'Seller', 0n);
    const base = { agentId: s.agentId, executor: 'builtin:scene-match', inputSchema: {} };
    await expect(market.publish(s.ownerId, { ...base, slug: 'free-resale', name: 'Free resale', offers: [{ mode: 'PER_CALL', priceGas: 10, sublicensable: true }] })).rejects.toThrow('SUBLICENSE_NEEDS_ROYALTY');
    await expect(market.publish(s.ownerId, { ...base, slug: 'netflix-episode-search', name: 'Episode search', offers: [{ mode: 'PER_CALL', priceGas: 10 }] })).rejects.toThrow('BRAND_RESERVED_PENDING_PARTNERSHIP:netflix');
    await expect(market.publish(s.ownerId, { ...base, slug: 'ep-search', name: 'Spotify playlist mixer', offers: [{ mode: 'PER_CALL', priceGas: 10 }] })).rejects.toThrow('BRAND_RESERVED_PENDING_PARTNERSHIP:spotify');
    expect(reservedBrand('Northwind Streaming')).toBeNull();
    expect(reservedBrand('Netflix Inc')).toBe('netflix');
    expect(reservedBrand('Netflix Inc', ['netflix'])).toBeNull();                      // a partner sells under its own name
  });
});
