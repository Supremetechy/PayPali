import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { AgentWalletService } from '../src/services/AgentWalletService';
import { AgentDevService } from '../src/agentdev/AgentDevService';
import { GasService } from '../src/market/GasService';
import { makePortalRegistry, ServicePortal, FulfilmentResult } from '../src/market/portals';
import { createTestDb, TestDb } from './harness';

const USD = 'USD';

// A live portal that leaves every order PENDING, so the provider must confirm it later via confirmOrder().
const pendingPortal: ServicePortal = { status: 'live', async fulfil(): Promise<FulfilmentResult> { return { status: 'PENDING', providerRef: 'awaiting' }; } };

let db: TestDb, prisma: PrismaClient, wallet: AgentWalletService, dev: AgentDevService, gas: GasService;

beforeEach(async () => {
  db = await createTestDb();
  prisma = db.prisma;
  wallet = new AgentWalletService(prisma);
  dev = new AgentDevService(prisma, wallet);
  gas = new GasService(prisma, wallet, dev.score, makePortalRegistry({ live: { netflix: pendingPortal } }));
});
afterEach(async () => { await db.close(); });

async function payer(fund = 200_000n) {
  const owner = await prisma.owner.create({ data: { email: `o_${randomUUID()}@example.com` } });
  const a = await prisma.agent.create({ data: { ownerId: owner.id, name: 'payer' } });
  await wallet.receive({ agentId: a.id, amountMinor: fund, currency: USD, idempotencyKey: randomUUID() });
  await dev.score.open(a.id);
  await dev.skills.grantCapability(owner.id, a.id, 'market.service', 'HIGH');
  return { ownerId: owner.id, agentId: a.id };
}

async function pendingOrder(agentId: string) {
  const q = await gas.estimate(agentId, { serviceId: 'netflix', actionId: 'subscribe_standard' });
  const paid = await gas.pay(agentId, { quoteId: q.quoteId, confidencePct: 80 });
  expect(paid.status).toBe('PENDING_PROVIDER');
  return { orderId: paid.orderId!, stakeId: paid.stakeId!, amountMinor: BigInt(q.amountMinor) };
}

describe('GasService.confirmOrder (provider confirmation webhook)', () => {
  it('a later success settles the OPEN stake WON and keeps the escrowed Gas', async () => {
    const a = await payer();
    const before = await wallet.getBalance(a.agentId, USD);
    const { orderId, stakeId, amountMinor } = await pendingOrder(a.agentId);
    // While pending, the Gas is escrowed and the Score bond is held, so available is below before.
    expect(await wallet.getBalance(a.agentId, USD)).toBeLessThan(before - amountMinor);
    expect((await prisma.scoreStake.findUnique({ where: { id: stakeId } }))?.status).toBe('OPEN');

    const r = await gas.confirmOrder(orderId, { success: true, providerRef: 'nf_123' });
    expect(r.status).toBe('FULFILLED');
    expect(r.settled).toBe(true);
    expect((await prisma.serviceOrder.findUnique({ where: { id: orderId } }))?.status).toBe('FULFILLED');
    expect((await prisma.scoreStake.findUnique({ where: { id: stakeId } }))?.status).toBe('WON');
    // On a win the bond is returned; only the escrowed Gas is permanently spent, and it is NOT refunded.
    expect(await wallet.getBalance(a.agentId, USD)).toBe(before - amountMinor);
  });

  it('a later rejection refunds the escrowed Gas and settles the stake LOST', async () => {
    const a = await payer();
    const { orderId, stakeId, amountMinor } = await pendingOrder(a.agentId);
    const pendingBal = await wallet.getBalance(a.agentId, USD);

    const r = await gas.confirmOrder(orderId, { success: false, reason: 'OUT_OF_STOCK' });
    expect(r.status).toBe('FAILED');
    expect(r.reasons).toContain('OUT_OF_STOCK');
    const order = await prisma.serviceOrder.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('FAILED');
    expect(order?.refundId).toBeTruthy();
    expect((await prisma.scoreStake.findUnique({ where: { id: stakeId } }))?.status).toBe('LOST');
    // The escrowed Gas came back (a LOST stake also forfeits part of the Score bond, so balance
    // rises by less than amountMinor overall, but strictly above the pending balance).
    expect(await wallet.getBalance(a.agentId, USD)).toBeGreaterThan(pendingBal);
    expect(await wallet.getBalance(a.agentId, USD)).toBeLessThanOrEqual(pendingBal + amountMinor);
  });

  it('is idempotent: re-confirming a settled order is a no-op and never double-refunds', async () => {
    const a = await payer();
    const { orderId } = await pendingOrder(a.agentId);
    await gas.confirmOrder(orderId, { success: false, reason: 'OUT_OF_STOCK' });
    const balAfterRefund = await wallet.getBalance(a.agentId, USD);

    const again = await gas.confirmOrder(orderId, { success: true });   // a replayed/late second webhook
    expect(again.settled).toBe(false);
    expect(again.status).toBe('FAILED');                                 // unchanged
    expect(await wallet.getBalance(a.agentId, USD)).toBe(balAfterRefund);
  });

  it('rejects an unknown order', async () => {
    await expect(gas.confirmOrder('nope', { success: true })).rejects.toThrow('ORDER_NOT_FOUND');
  });
});

describe('GasService platform portal credentials', () => {
  it('fails closed before reserving funds when a required provider credential is absent', async () => {
    const a = await payer();
    const before = await wallet.getBalance(a.agentId, USD);
    const securedPortal: ServicePortal = {
      status: 'live',
      requiresSecret: true,
      async fulfil(): Promise<FulfilmentResult> { return { status: 'FULFILLED', providerRef: 'unexpected' }; },
    };
    gas = new GasService(prisma, wallet, dev.score, makePortalRegistry({
      live: { netflix: securedPortal },
      secretFor: async () => null,
    }));

    const q = await gas.estimate(a.agentId, { serviceId: 'netflix', actionId: 'subscribe_standard' });
    const result = await gas.pay(a.agentId, { quoteId: q.quoteId, confidencePct: 80 });

    expect(result).toMatchObject({ status: 'UNSUPPORTED', reasons: ['PROVIDER_CREDENTIAL_NOT_CONFIGURED'] });
    expect(await prisma.serviceOrder.count()).toBe(0);
    expect(await wallet.getBalance(a.agentId, USD)).toBe(before);
  });

  it('passes a required credential out-of-band to the live adapter', async () => {
    const a = await payer();
    let received: string | undefined;
    const securedPortal: ServicePortal = {
      status: 'live',
      requiresSecret: true,
      async fulfil(_order, secret): Promise<FulfilmentResult> {
        received = secret;
        return { status: 'FULFILLED', providerRef: 'provider-order-1' };
      },
    };
    gas = new GasService(prisma, wallet, dev.score, makePortalRegistry({
      live: { netflix: securedPortal },
      secretFor: async () => 'platform-integration-secret',
    }));

    const q = await gas.estimate(a.agentId, { serviceId: 'netflix', actionId: 'subscribe_standard' });
    const result = await gas.pay(a.agentId, { quoteId: q.quoteId, confidencePct: 80 });

    expect(result.status).toBe('FULFILLED');
    expect(received).toBe('platform-integration-secret');
    const order = await prisma.serviceOrder.findFirstOrThrow();
    expect(JSON.stringify(order.fulfillment)).not.toContain('platform-integration-secret');
  });

  it('does not persist or return a provider error message that may contain the credential', async () => {
    const a = await payer();
    const secret = 'platform-integration-secret';
    const securedPortal: ServicePortal = {
      status: 'live',
      requiresSecret: true,
      async fulfil(_order, received): Promise<FulfilmentResult> {
        throw new Error(`provider rejected credential ${received}`);
      },
    };
    gas = new GasService(prisma, wallet, dev.score, makePortalRegistry({
      live: { netflix: securedPortal },
      secretFor: async () => secret,
    }));

    const q = await gas.estimate(a.agentId, { serviceId: 'netflix', actionId: 'subscribe_standard' });
    const result = await gas.pay(a.agentId, { quoteId: q.quoteId, confidencePct: 80 });
    const order = await prisma.serviceOrder.findFirstOrThrow();

    expect(result.status).toBe('PENDING_PROVIDER');
    expect(JSON.stringify(result.fulfillment)).not.toContain(secret);
    expect(JSON.stringify(order.fulfillment)).not.toContain(secret);
  });
});
