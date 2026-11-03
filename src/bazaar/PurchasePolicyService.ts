import { AgentPurchasePolicy, PrismaClient } from '@prisma/client';
import {
  Permission,
  PolicyDecision,
  PURCHASE_CATEGORIES,
  PURCHASE_CATEGORY_KEYS,
  PurchaseContext,
  PurchasePolicyOverride,
  isPurchaseCategory,
  resolvePurchasePolicy,
} from './purchasePolicy';

// Owner-facing side of the purchase policy: read the effective taxonomy for an
// agent, set or clear per-category overrides, and resolve one purchase against
// them. The decision logic itself lives in purchasePolicy (pure, unit-tested).

const err = (code: string) => new Error(code);
const PERMISSIONS: Permission[] = ['PREAPPROVED', 'CONFIRM', 'PROHIBITED'];

export class PurchasePolicyService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Resolve the permission for one purchase, applying the owner's override for its category. */
  async resolve(agentId: string, ctx: PurchaseContext): Promise<PolicyDecision> {
    let override: PurchasePolicyOverride | undefined;
    if (ctx.category && isPurchaseCategory(ctx.category)) {
      const row = await this.prisma.agentPurchasePolicy.findUnique({ where: { agentId_category: { agentId, category: ctx.category } } });
      if (row) override = { permission: row.permission as Permission, maxAmountMinor: row.maxAmountMinor };
    }
    return resolvePurchasePolicy(ctx, override);
  }

  /** Owner act: tighten or loosen one category for an agent (or set a PREAPPROVED cap). */
  async setPolicy(ownerId: string, agentId: string, category: string, p: { permission: Permission; maxAmountMinor?: bigint | null }) {
    await this.ownedAgent(ownerId, agentId);
    if (!isPurchaseCategory(category)) throw err('UNKNOWN_PURCHASE_CATEGORY');
    if (!PERMISSIONS.includes(p.permission)) throw err('INVALID_PERMISSION');
    if (p.maxAmountMinor != null && !(typeof p.maxAmountMinor === 'bigint' && p.maxAmountMinor >= 0n)) throw err('INVALID_MAX_AMOUNT');
    const data = { permission: p.permission, maxAmountMinor: p.maxAmountMinor ?? null, grantedBy: ownerId };
    const row = await this.prisma.agentPurchasePolicy.upsert({
      where: { agentId_category: { agentId, category } },
      update: data,
      create: { agentId, category, ...data },
    });
    return this.overrideView(row);
  }

  /** Owner act: drop an override so the category falls back to its taxonomy default. */
  async clearPolicy(ownerId: string, agentId: string, category: string) {
    await this.ownedAgent(ownerId, agentId);
    await this.prisma.agentPurchasePolicy.deleteMany({ where: { agentId, category } });
    return { cleared: true };
  }

  /** Effective policy for every category: the taxonomy default with any owner override applied. */
  async getPolicies(agentId: string) {
    const rows = await this.prisma.agentPurchasePolicy.findMany({ where: { agentId } });
    const byCat = new Map(rows.map((r) => [r.category, r]));
    return PURCHASE_CATEGORY_KEYS.map((key) => {
      const c = PURCHASE_CATEGORIES[key];
      const o = byCat.get(key);
      return {
        category: key,
        label: c.label,
        description: c.description,
        example: c.example,
        risk: c.risk,
        defaultPermission: c.permission,
        permission: (o?.permission as Permission) ?? c.permission,
        preapprovedMaxMinor: o ? o.maxAmountMinor : c.preapprovedMaxMinor ?? null,
        personalData: !!c.personalData,
        recurringCommon: !!c.recurringCommon,
        overridden: !!o,
      };
    });
  }

  private overrideView(r: AgentPurchasePolicy) {
    return { agentId: r.agentId, category: r.category, permission: r.permission, maxAmountMinor: r.maxAmountMinor, grantedBy: r.grantedBy, updatedAt: r.updatedAt };
  }

  private async ownedAgent(ownerId: string, agentId: string) {
    const a = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!a || a.ownerId !== ownerId) throw err('AGENT_NOT_OWNED');
    return a;
  }
}
