import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { AgentWalletService } from '../src/services/AgentWalletService';
import { AgentDevService } from '../src/agentdev/AgentDevService';
import { AgentConnectService } from '../src/connect/AgentConnectService';
import { AgencyService } from '../src/agency/AgencyService';
import { buildPlan, needsFor } from '../src/market/plan';
import { createTestDb, TestDb } from './harness';

let db: TestDb, prisma: PrismaClient, wallet: AgentWalletService, dev: AgentDevService, connect: AgentConnectService, agency: AgencyService;
beforeEach(async () => {
  db = await createTestDb(); prisma = db.prisma;
  wallet = new AgentWalletService(prisma); dev = new AgentDevService(prisma, wallet);
  connect = new AgentConnectService(prisma, dev); agency = new AgencyService({ prisma, score: dev.score, connect });
});
afterEach(async () => db.close());

async function setup() {
  const o = await prisma.owner.create({ data: { email: `o_${randomUUID()}@example.com` } });
  const a = await prisma.agent.create({ data: { ownerId: o.id, name: 'Shopper' } });
  const sel = [{ kind: 'platform', itemId: 'claude' }, { kind: 'service', itemId: 'spotify' }, { kind: 'service', itemId: 'netflix' }, { kind: 'data', itemId: 'acme-freight' }];
  await prisma.marketSelection.createMany({ data: sel.map((x) => ({ agentId: a.id, ...x })) });
  return { ownerId: o.id, agentId: a.id };
}
const plan = (agentId: string) => buildPlan({ prisma, dev, wallet, agency, portalStatus: (id) => (id === 'netflix' ? 'placeholder' : 'sandbox') }, agentId);
const item = (p: Awaited<ReturnType<typeof plan>>, key: string) => p.items.find((x) => x.key === key)!;

describe('Marketplace plan: from selected to usable', () => {
  it('a fresh agent: every step says what to do next', async () => {
    const a = await setup();
    const p = await plan(a.agentId);
    expect(item(p, 'agent:funds')).toMatchObject({ state: 'todo', action: { type: 'fund' } });
    expect(item(p, 'agent:poa')).toMatchObject({ state: 'todo', action: { type: 'sign' } });
    expect(item(p, 'agent:assistant')).toMatchObject({ state: 'todo', action: { type: 'connect', platform: 'claude' } });
    expect(item(p, 'platform:claude')).toMatchObject({ state: 'todo', action: { type: 'connect' } });
    expect(item(p, 'service:spotify')).toMatchObject({ state: 'todo', action: { type: 'grant', capability: 'market.service' } });
    expect(item(p, 'service:spotify').howTo!.tools).toContain('pay_with_gas');
    expect(item(p, 'data:acme-freight')).toMatchObject({ state: 'blocked' });          // not listed in this database
    expect(p.ready).toBe(0);
  });

  it('progresses as the owner funds, grants, connects, widens access and signs', async () => {
    const a = await setup();
    await wallet.receive({ agentId: a.agentId, amountMinor: 5_000n, currency: 'USD', idempotencyKey: randomUUID() });
    const { connection } = await connect.createConnection(a.ownerId, a.agentId, { provider: 'claude', scopes: ['context:read', 'wallet:read'], mandate: { maxPerTxMinor: 2_000n, maxDailyMinor: 5_000n, allowedServices: ['uber'] } });
    let p = await plan(a.agentId);
    expect(item(p, 'agent:funds').state).toBe('done');
    expect(item(p, 'platform:claude')).toMatchObject({ state: 'done', status: 'Connected · waiting for its first call' });
    const access = item(p, 'agent:access');
    expect(access.state).toBe('todo');
    expect(access.action).toMatchObject({ type: 'extend', connections: [{ id: connection.id, addScopes: expect.arrayContaining(['gas:pay', 'data:query']), addServices: ['spotify', 'netflix', 'data:acme-freight'] }] });

    const r = await connect.extendAccess(a.ownerId, connection.id, needsFor([{ kind: 'service', id: 'spotify' }, { kind: 'service', id: 'netflix' }, { kind: 'data', id: 'acme-freight' }]));
    expect(r.connection.scopes).toEqual(expect.arrayContaining(['gas:pay', 'gas:quote', 'market:read', 'data:query']));
    expect(r.connection.allowedServices).toEqual(['uber', 'spotify', 'netflix', 'data:acme-freight']);
    expect(r.connection.maxPerTxMinor).toBe(2_000n);                                   // limits untouched
    p = await plan(a.agentId);
    expect(item(p, 'agent:access').state).toBe('done');
    expect(item(p, 'service:spotify')).toMatchObject({ state: 'todo', action: { type: 'open', label: 'Try it now' } });   // capability came with gas:pay
    expect(item(p, 'service:netflix')).toMatchObject({ state: 'blocked' });          // placeholder portal

    await agency.sign(a.ownerId, a.agentId);
    p = await plan(a.agentId);
    expect(item(p, 'agent:poa').state).toBe('done');
    await dev.skills.grantCapability(a.ownerId, a.agentId, 'bazaar.purchase', 'HIGH');  // authority changed → re-sign
    expect(item(await plan(a.agentId), 'agent:poa')).toMatchObject({ state: 'todo', title: 'Re-sign the Power of Agency' });
  });

  it('a stopped agent says so first; a connection allowing everything needs no widening of services', async () => {
    const a = await setup();
    await connect.createConnection(a.ownerId, a.agentId, { provider: 'claude', scopes: ['market:read', 'gas:pay', 'data:query'], mandate: { maxPerTxMinor: 2_000n, maxDailyMinor: 5_000n } });
    expect(item(await plan(a.agentId), 'agent:access').state).toBe('done');
    await prisma.agent.update({ where: { id: a.agentId }, data: { isActive: false } });
    expect((await plan(a.agentId)).items[0]).toMatchObject({ key: 'agent:active', state: 'blocked' });
  });
});
