import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AgentWalletService } from '../src/services/AgentWalletService';
import { LivePaymentService, LiveResult } from '../src/services/LivePaymentService';
import { DevPayPalCommerceGateway } from '../src/providers/paypal/DevPayPalCommerceGateway';
import { DevBrowserCheckoutDriver } from '../src/providers/checkout/DevBrowserCheckoutDriver';
import { AgentDevService } from '../src/agentdev/AgentDevService';
import { judgeLive } from '../src/agentdev/ScoredExecutor';
import { createTestDb, TestDb } from './harness';

let db: TestDb;
let prisma: PrismaClient;
let wallet: AgentWalletService;
let dev: AgentDevService;
let clock: number;

beforeEach(async () => {
  db = await createTestDb();
  prisma = db.prisma;
  wallet = new AgentWalletService(prisma);
  clock = Date.parse('2026-10-27T12:00:00Z');
  dev = new AgentDevService(prisma, wallet, {}, () => new Date(clock));
});
afterEach(async () => db.close());

const USD = 'USD';
const declined: LiveResult = { status: 'DECLINED', reason: 'PAYEE_REJECTED', idempotencyKey: 'x' };
const paid: LiveResult = { status: 'PAID', idempotencyKey: 'x', amountMinor: 1n, currency: USD };

/** Owner + developed agent, funded, with wallet.pay granted up to HIGH. */
async function developed(fundMinor = 100_000n, opts: { initialPoints?: number; floor?: number } = {}) {
  const owner = await prisma.owner.create({ data: { email: `o_${randomUUID()}@example.com` } });
  const agent = await prisma.agent.create({ data: { ownerId: owner.id, name: 'dev-agent' } });
  if (fundMinor > 0n) await wallet.receive({ agentId: agent.id, amountMinor: fundMinor, currency: USD, idempotencyKey: randomUUID() });
  await dev.develop(owner.id, agent.id, opts);
  await dev.skills.grantCapability(owner.id, agent.id, 'wallet.pay', 'HIGH');
  return { ownerId: owner.id, agentId: agent.id };
}

const req = (agentId: string, o: Partial<{ intentKey: string; confidencePct: number; capability: string; skillId: string; amountMinor: bigint }> = {}) => ({
  agentId, capability: 'wallet.pay', intentKey: 'buy-widget', confidencePct: 90, currency: USD, ...o,
});

describe('score gate: consequence before acting', () => {
  it('quotes without writing anything', async () => {
    const { agentId } = await developed();
    const q = await dev.score.quote(req(agentId));
    expect(q.allowed).toBe(true);
    expect(q.onSuccess).toBeGreaterThan(0);
    expect(q.onFailure).toBeLessThan(0);
    expect(q.bondMinor).toBe(BigInt(q.lockedPoints));
    expect(await prisma.scoreStake.count()).toBe(0);
    expect(await wallet.getBalance(agentId, USD)).toBe(100_000n);
  });

  it('commit locks points AND holds a real wallet bond before the action runs', async () => {
    const { agentId } = await developed();
    const { stakeId, quote } = await dev.score.commit(req(agentId));
    const acct = await dev.score.getAccount(agentId);
    expect(acct!.lockedPoints).toBe(quote.lockedPoints);
    expect(await wallet.getBalance(agentId, USD)).toBe(100_000n - quote.bondMinor);
    expect(await wallet.getReserved(agentId, USD)).toBe(quote.bondMinor);
    expect((await prisma.scoreStake.findUnique({ where: { id: stakeId } }))!.status).toBe('OPEN');
  });

  it('a win releases the whole bond and pays calibrated points', async () => {
    const { agentId } = await developed();
    const r = await dev.executor.run(req(agentId), async () => paid, judgeLive);
    expect(r.settlement!.status).toBe('WON');
    expect(r.settlement!.delta).toBe(r.quote.onSuccess);
    expect(await wallet.getBalance(agentId, USD)).toBe(100_000n);
    expect(await wallet.getReserved(agentId, USD)).toBe(0n);
    expect((await dev.score.getAccount(agentId))!.balance).toBe(1000 + r.quote.onSuccess);
  });

  it('a loss burns points and forfeits the matching bond to the Score Pool', async () => {
    const { agentId } = await developed();
    const r = await dev.executor.run(req(agentId), async () => declined, judgeLive);
    const lost = -r.quote.onFailure;
    expect(r.settlement!.status).toBe('LOST');
    expect(r.settlement!.forfeitedMinor).toBe(BigInt(lost));
    expect(await wallet.getBalance(agentId, USD)).toBe(100_000n - BigInt(lost));
    expect(await wallet.getReserved(agentId, USD)).toBe(0n);
    const pool = await dev.score.poolAgent();
    expect(await wallet.getBalance(pool, USD)).toBe(BigInt(lost));
    expect((await dev.score.getAccount(agentId))!.balance).toBe(1000 - lost);
  });

  it('settlement is exactly-once', async () => {
    const { agentId } = await developed();
    const { stakeId } = await dev.score.commit(req(agentId));
    const a = await dev.score.settle(stakeId, { success: false });
    const b = await dev.score.settle(stakeId, { success: true });
    expect(b.replayed).toBe(true);
    expect(b.status).toBe('LOST');
    expect((await dev.score.getAccount(agentId))!.balance).toBe(a.balanceAfter);
  });

  it('retries of the same goal cost more, and stop after 3 attempts', async () => {
    const { agentId } = await developed();
    const stakes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await dev.executor.run(req(agentId, { confidencePct: 60 }), async () => declined, judgeLive);
      stakes.push(r.quote.stake);
    }
    expect(stakes).toEqual([40, 80, 160]);
    const q = await dev.score.quote(req(agentId, { confidencePct: 60 }));
    expect(q.reasons).toContain('ATTEMPTS_EXHAUSTED');
  });

  it('a goal that already succeeded cannot be re-staked for more points', async () => {
    const { agentId } = await developed();
    await dev.executor.run(req(agentId), async () => paid, judgeLive);
    expect((await dev.score.quote(req(agentId))).reasons).toContain('INTENT_ALREADY_ACHIEVED');
  });

  it('fails closed: no capability, unbound skill, no bond money, risk above grant', async () => {
    const { agentId, ownerId } = await developed(10n);
    expect((await dev.score.quote(req(agentId, { capability: 'wallet.payout' }))).reasons).toContain('CAPABILITY_NOT_GRANTED');
    expect((await dev.score.quote(req(agentId, { skillId: randomUUID() }))).reasons).toContain('SKILL_NOT_BOUND');
    expect((await dev.score.quote(req(agentId))).reasons).toContain('INSUFFICIENT_FUNDS_FOR_BOND');
    await dev.skills.grantCapability(ownerId, agentId, 'wallet.pay', 'LOW');
    expect((await dev.score.quote(req(agentId))).reasons).toContain('RISK_ABOVE_GRANT');
    const ran = await dev.executor.run(req(agentId), async () => { throw new Error('must not run'); }, judgeLive);
    expect(ran.allowed).toBe(false);
  });

  it('an ambiguous result keeps the stake open; expiry settles it as a loss', async () => {
    const { agentId } = await developed();
    const r = await dev.executor.run(req(agentId), async (): Promise<LiveResult> => ({ status: 'AMBIGUOUS', idempotencyKey: 'x' }), judgeLive);
    expect(r.pending).toBe(true);
    clock += 16 * 60_000;
    expect(await dev.score.expireDue()).toBe(1);
    expect((await prisma.scoreStake.findUnique({ where: { id: r.stakeId! } }))!.status).toBe('EXPIRED');
    expect(await wallet.getReserved(agentId, USD)).toBe(0n);
  });

  it('crossing the floor suspends the score AND deactivates the agent for all money movement', async () => {
    const { agentId } = await developed(100_000n, { initialPoints: 400, floor: 300 });
    // starts in PROBATION (400 < 450): only LOW risk allowed
    expect((await dev.score.quote(req(agentId))).reasons).toContain('PROBATION_LOW_RISK_ONLY');
    await prisma.agentScore.update({ where: { agentId }, data: { status: 'ACTIVE' } }); // force a risky action through
    const r = await dev.executor.run(req(agentId, { confidencePct: 99 }), async () => declined, judgeLive);
    expect(r.settlement!.scoreStatus).toBe('SUSPENDED');
    expect((await prisma.agent.findUnique({ where: { id: agentId } }))!.isActive).toBe(false);
    expect((await dev.score.quote(req(agentId, { intentKey: 'other' }))).allowed).toBe(false);
  });

  it('runs a real LivePaymentService payment under the gate', async () => {
    const { agentId } = await developed();
    const live = new LivePaymentService(prisma, wallet, new DevPayPalCommerceGateway(), new DevBrowserCheckoutDriver());
    const r = await dev.executor.run(req(agentId, { amountMinor: 2_500n }),
      () => live.pay({ agentId, payeeReference: 'merchant-1', amountMinor: 2_500n, currency: USD, description: 'widget', idempotencyKey: randomUUID() }),
      judgeLive);
    expect(r.result!.status).toBe('PAID');
    expect(r.settlement!.status).toBe('WON');
    expect(await wallet.getBalance(agentId, USD)).toBe(100_000n - 2_500n);
  });
});

describe('knowledge modules, skills, memory, passes', () => {
  it('serves only owner-provided, bound, active, cited facts', async () => {
    const { agentId, ownerId } = await developed();
    const mod = await dev.knowledge.createModule(ownerId, 'procurement');
    await dev.knowledge.addFact(ownerId, mod.id, { statement: 'Approved widget vendor is Acme; net-30 terms.', source: 'owner chat 2026-10-27', tags: ['vendor'] });
    await expect(dev.knowledge.addFact(ownerId, mod.id, { statement: 'x', source: '' })).rejects.toThrow('FACT_SOURCE_REQUIRED');
    expect(await dev.knowledge.retrieve(agentId, { query: 'widget vendor' })).toHaveLength(0); // not bound yet
    await dev.knowledge.bindModule(ownerId, agentId, mod.id);
    const got = await dev.knowledge.retrieve(agentId, { query: 'widget vendor' });
    expect(got[0].source).toBe('owner chat 2026-10-27');

    const proposed = await dev.knowledge.proposeFact(agentId, mod.id, { statement: 'Acme gives 5% off over $500.', source: 'invoice #88' });
    expect((await dev.knowledge.retrieve(agentId, { query: 'acme' })).map((f) => f.id)).not.toContain(proposed.id);
    await dev.knowledge.approveFact(ownerId, proposed.id);
    expect((await dev.knowledge.retrieve(agentId, { query: 'acme' })).map((f) => f.id)).toContain(proposed.id);

    const other = await prisma.owner.create({ data: { email: `x_${randomUUID()}@example.com` } });
    await expect(dev.knowledge.addFact(other.id, mod.id, { statement: 'evil', source: 's' })).rejects.toThrow('MODULE_NOT_OWNED');
  });

  it('supersedes facts instead of editing them', async () => {
    const { agentId, ownerId } = await developed();
    const mod = await dev.knowledge.createModule(ownerId, 'k');
    await dev.knowledge.bindModule(ownerId, agentId, mod.id);
    const f1 = await dev.knowledge.addFact(ownerId, mod.id, { statement: 'Budget cap is $200', source: 'owner' });
    const f2 = await dev.knowledge.supersedeFact(ownerId, f1.id, { statement: 'Budget cap is $300', source: 'owner, revised' });
    const ids = (await dev.knowledge.retrieve(agentId, { query: 'budget' })).map((f) => f.id);
    expect(ids).toEqual([f2.id]);
    expect((await prisma.knowledgeFact.findUnique({ where: { id: f1.id } }))!.supersededById).toBe(f2.id);
  });

  it('skills are versioned procedures and must declare the capability they use', async () => {
    const { agentId, ownerId } = await developed();
    const s1 = await dev.skills.defineSkill(ownerId, { name: 'pay-invoice', steps: ['verify payee in knowledge', 'quote', 'pay'], requiredCapabilities: ['wallet.pay'], riskClass: 'MEDIUM' });
    const s2 = await dev.skills.defineSkill(ownerId, { name: 'pay-invoice', steps: ['verify', 'pay'], requiredCapabilities: ['wallet.pay'] });
    expect([s1.version, s2.version]).toEqual([1, 2]);
    await expect(dev.skills.defineSkill(ownerId, { name: 'x', steps: ['a'], requiredCapabilities: ['root.shell'] })).rejects.toThrow('UNKNOWN_CAPABILITY');
    await dev.skills.bindSkill(ownerId, agentId, s1.id);
    expect((await dev.score.quote(req(agentId, { skillId: s1.id }))).allowed).toBe(true);
    const payout = await dev.skills.defineSkill(ownerId, { name: 'refund', steps: ['payout'], requiredCapabilities: ['wallet.payout'] });
    await dev.skills.bindSkill(ownerId, agentId, payout.id);
    expect((await dev.score.quote(req(agentId, { skillId: payout.id }))).reasons).toContain('SKILL_DOES_NOT_USE_CAPABILITY');
  });

  it('revoking a capability takes effect on the next quote', async () => {
    const { agentId, ownerId } = await developed();
    await dev.skills.revokeCapability(ownerId, agentId, 'wallet.pay');
    expect((await dev.score.quote(req(agentId))).reasons).toContain('CAPABILITY_NOT_GRANTED');
  });

  it('background passes turn scored history into behavioral lessons', async () => {
    const { agentId, ownerId } = await developed();
    for (let i = 0; i < 4; i++) {
      await dev.executor.run(req(agentId, { intentKey: `goal-${i}`, confidencePct: 95 }), async () => (i === 0 ? paid : declined), judgeLive);
    }
    await dev.memory.setOwnerMemory(ownerId, agentId, 'confirm-totals', 'Always confirm the invoice total against the PO before paying.');
    const report = await dev.passes.runAll();
    expect(report.lessonsWritten).toBeGreaterThanOrEqual(2);
    const mem = await dev.memory.list(agentId);
    const calib = mem.find((m) => m.key === 'lesson:calibration.wallet.pay')!;
    expect(calib.content).toMatch(/overconfident by 70 points/);
    expect(mem.find((m) => m.key === 'lesson:failures.wallet.pay')!.content).toMatch(/PAYEE_REJECTED \(3x\)/);
    expect(mem.some((m) => m.kind === 'BEHAVIOR')).toBe(true);
  });

  it('context() assembles knowledge, skills, capabilities, memory and score for the runtime', async () => {
    const { agentId, ownerId } = await developed();
    const mod = await dev.knowledge.createModule(ownerId, 'm');
    await dev.knowledge.bindModule(ownerId, agentId, mod.id);
    await dev.knowledge.addFact(ownerId, mod.id, { statement: 'Ship to warehouse B', source: 'owner' });
    const ctx = await dev.context(agentId, { query: 'ship warehouse' });
    expect(ctx.score.available).toBe(1000);
    expect(ctx.capabilities.map((c) => c.capability)).toEqual(['wallet.pay']);
    expect(ctx.knowledge).toHaveLength(1);
    expect(ctx.rules.summary).toMatch(/bond/);
  });
});
