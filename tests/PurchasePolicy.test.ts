import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { resolvePurchasePolicy } from '../src/bazaar/purchasePolicy';
import { PurchasePolicyService } from '../src/bazaar/PurchasePolicyService';
import { createTestDb, TestDb } from './harness';

describe('resolvePurchasePolicy (pure)', () => {
  it('auto-approves a low-risk category within its ceiling', () => {
    const d = resolvePurchasePolicy({ category: 'compute_model', amountMinor: 5_000n });
    expect(d.permission).toBe('PREAPPROVED');
    expect(d.category).toBe('compute_model');
  });

  it('escalates a preapproved purchase over its ceiling to CONFIRM', () => {
    const d = resolvePurchasePolicy({ category: 'information_research', amountMinor: 50_000n }); // $500 > $20 default
    expect(d.permission).toBe('CONFIRM');
    expect(d.reasons).toContain('OVER_PREAPPROVED_LIMIT');
  });

  it('forces CONFIRM for recurring, paid access and personal data', () => {
    expect(resolvePurchasePolicy({ category: 'compute_model', amountMinor: 100n, recurring: true }).permission).toBe('CONFIRM');
    expect(resolvePurchasePolicy({ category: 'compute_model', amountMinor: 100n, paidAccess: true }).permission).toBe('CONFIRM');
    const pd = resolvePurchasePolicy({ category: 'api_data_access', amountMinor: 100n, personalData: true });
    expect(pd.permission).toBe('CONFIRM');
    expect(pd.reasons).toContain('PERSONAL_DATA_REQUIRES_APPROVAL');
  });

  it('treats a category that inherently touches personal data as CONFIRM', () => {
    const d = resolvePurchasePolicy({ category: 'identity_access', amountMinor: 100n });
    expect(d.permission).toBe('CONFIRM');
    expect(d.reasons).toContain('PERSONAL_DATA_REQUIRES_APPROVAL');
  });

  it('leaves an uncategorized purchase to the existing gates, but still escalates on sensitive attributes', () => {
    const plain = resolvePurchasePolicy({ amountMinor: 100n });
    expect(plain.permission).toBe('PREAPPROVED');       // defers to mandate/cap/Score
    expect(plain.category).toBe('uncategorized');
    expect(plain.reasons).toContain('UNCATEGORIZED');
    // an unknown category string is treated the same
    expect(resolvePurchasePolicy({ category: 'not_a_real_category', amountMinor: 100n }).category).toBe('uncategorized');
    // but recurring / personal data still force CONFIRM even when uncategorized
    expect(resolvePurchasePolicy({ amountMinor: 100n, recurring: true }).permission).toBe('CONFIRM');
    expect(resolvePurchasePolicy({ amountMinor: 100n, personalData: true }).permission).toBe('CONFIRM');
  });

  it('honors an owner override that prohibits or loosens a category', () => {
    expect(resolvePurchasePolicy({ category: 'compute_model', amountMinor: 100n }, { permission: 'PROHIBITED' }).permission).toBe('PROHIBITED');
    // loosen a CONFIRM category to PREAPPROVED (owner accepts the risk)
    expect(resolvePurchasePolicy({ category: 'travel_transport', amountMinor: 100n }, { permission: 'PREAPPROVED' }).permission).toBe('PREAPPROVED');
    // ...but recurring still pulls it back to CONFIRM even when loosened
    expect(resolvePurchasePolicy({ category: 'travel_transport', amountMinor: 100n, recurring: true }, { permission: 'PREAPPROVED' }).permission).toBe('CONFIRM');
  });

  it('applies an owner per-category cap over the category default ceiling', () => {
    // owner caps compute auto-approval at $5; a $50 compute buy now needs confirmation
    const d = resolvePurchasePolicy({ category: 'compute_model', amountMinor: 5_000n }, { permission: 'PREAPPROVED', maxAmountMinor: 500n });
    expect(d.permission).toBe('CONFIRM');
    expect(d.reasons).toContain('OVER_PREAPPROVED_LIMIT');
  });
});

describe('PurchasePolicyService (overrides)', () => {
  let db: TestDb, prisma: PrismaClient, policy: PurchasePolicyService;
  let ownerId: string, agentId: string;

  beforeEach(async () => {
    db = await createTestDb();
    prisma = db.prisma;
    policy = new PurchasePolicyService(prisma);
    const owner = await prisma.owner.create({ data: { email: `o_${randomUUID()}@example.com` } });
    ownerId = owner.id;
    agentId = (await prisma.agent.create({ data: { ownerId, name: 'buyer' } })).id;
  });
  afterEach(async () => { await db.close(); });

  it('set → get → resolve reflects the override', async () => {
    await policy.setPolicy(ownerId, agentId, 'donations_contributions', { permission: 'PROHIBITED' });
    const view = (await policy.getPolicies(agentId)).find((p) => p.category === 'donations_contributions')!;
    expect(view.permission).toBe('PROHIBITED');
    expect(view.overridden).toBe(true);
    const d = await policy.resolve(agentId, { category: 'donations_contributions', amountMinor: 100n });
    expect(d.permission).toBe('PROHIBITED');
  });

  it('getPolicies returns all 18 categories with defaults when nothing is overridden', async () => {
    const all = await policy.getPolicies(agentId);
    expect(all).toHaveLength(18);
    expect(all.every((p) => p.overridden === false)).toBe(true);
  });

  it('rejects an unknown category, bad permission, and a non-owner', async () => {
    await expect(policy.setPolicy(ownerId, agentId, 'nope', { permission: 'CONFIRM' })).rejects.toThrow('UNKNOWN_PURCHASE_CATEGORY');
    // @ts-expect-error bad permission value
    await expect(policy.setPolicy(ownerId, agentId, 'compute_model', { permission: 'MAYBE' })).rejects.toThrow('INVALID_PERMISSION');
    await expect(policy.setPolicy('someone-else', agentId, 'compute_model', { permission: 'CONFIRM' })).rejects.toThrow('AGENT_NOT_OWNED');
  });
});
