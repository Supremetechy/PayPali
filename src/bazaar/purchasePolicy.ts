import { RiskClass } from '@prisma/client';

// ---------------------------------------------------------------------------
// Purchase policy: what an agent is allowed to buy, and whether a human must
// confirm first. This is the use-case taxonomy an agent purchase falls under
// (distinct from a listing's industry `category` like Finance or Travel) mapped
// to a permission under the three-way model:
//
//   PREAPPROVED  allowed within a narrow budget and scope, no human in the loop
//   CONFIRM      show item, vendor, total and terms, then wait for owner approval
//   PROHIBITED   never allowed (unauthorized, deceptive, illegal, or off-task)
//
// Recurring charges, paid access, and anything touching personal data always
// escalate to at least CONFIRM, whatever the category default — the owner must
// see the renewal, cancellation and data-use terms before checkout.
//
// The resolver is pure. Per-agent overrides (an owner tightening or loosening a
// category, or setting a cap) live in AgentPurchasePolicy and are passed in.
// ---------------------------------------------------------------------------

export type Permission = 'PREAPPROVED' | 'CONFIRM' | 'PROHIBITED';

export type PurchaseCategoryKey =
  | 'skills_software'
  | 'compute_model'
  | 'information_research'
  | 'api_data_access'
  | 'identity_access'
  | 'digital_content'
  | 'communication'
  | 'travel_transport'
  | 'physical_goods'
  | 'professional_services'
  | 'subscriptions_memberships'
  | 'licenses_permits_fees'
  | 'testing_validation'
  | 'delivery_fulfillment'
  | 'advertising_promo'
  | 'donations_contributions'
  | 'financial_transactions'
  | 'contingency';

export interface PurchaseCategory {
  key: PurchaseCategoryKey;
  label: string;
  description: string;
  example: string;
  /** Default permission when no per-agent override applies. */
  permission: Permission;
  /** Advisory risk for this kind of purchase; the Score gate still applies its own amount risk. */
  risk: RiskClass;
  /** PREAPPROVED categories are only auto-allowed up to this amount; above it they escalate to CONFIRM. */
  preapprovedMaxMinor?: bigint;
  /** This category inherently involves personal data (so it always needs explicit approval). */
  personalData?: boolean;
  /** Charges in this category are commonly recurring (surfaced to owners; does not by itself change the gate). */
  recurringCommon?: boolean;
}

export const PURCHASE_CATEGORIES: Record<PurchaseCategoryKey, PurchaseCategory> = {
  skills_software: {
    key: 'skills_software', label: 'Skills & software capabilities',
    description: 'Software licenses, plugins, APIs, model tools, code, libraries, workflow templates, or specialized agent skills.',
    example: 'Buying access to a doc-conversion tool or a paid data-analyst package.',
    permission: 'PREAPPROVED', risk: 'LOW', preapprovedMaxMinor: 5_000n,
  },
  compute_model: {
    key: 'compute_model', label: 'Compute & model usage',
    description: 'Cloud compute, GPU time, model inference, fine-tuning, storage, or extra usage capacity.',
    example: 'Renting GPU to process a large dataset.',
    permission: 'PREAPPROVED', risk: 'LOW', preapprovedMaxMinor: 10_000n,
  },
  information_research: {
    key: 'information_research', label: 'Information & research',
    description: 'Paid database queries, reports, datasets, research papers, news archives, or market intelligence.',
    example: 'Paying for a company-record lookup or a financial-data query.',
    permission: 'PREAPPROVED', risk: 'LOW', preapprovedMaxMinor: 2_000n,
  },
  api_data_access: {
    key: 'api_data_access', label: 'API & data access',
    description: 'API credits, premium endpoints, higher rate limits, data feeds, or usage tiers.',
    example: 'Purchasing additional geocoding requests.',
    permission: 'PREAPPROVED', risk: 'LOW', preapprovedMaxMinor: 2_000n,
  },
  identity_access: {
    key: 'identity_access', label: 'Identity & account access',
    description: 'Account creation, verification, authentication, or access subscriptions, where permitted.',
    example: 'Paying for an authorized identity-verification check.',
    permission: 'CONFIRM', risk: 'HIGH', personalData: true,
  },
  digital_content: {
    key: 'digital_content', label: 'Digital content',
    description: 'E-books, images, music, video, fonts, stock assets, maps, or other licensed media.',
    example: 'Licensing an image for a presentation.',
    permission: 'PREAPPROVED', risk: 'LOW', preapprovedMaxMinor: 2_000n,
  },
  communication: {
    key: 'communication', label: 'Communication services',
    description: 'Email, SMS, phone, video-conferencing, translation, or messaging services.',
    example: 'Buying a one-time SMS verification or international calling credit.',
    permission: 'PREAPPROVED', risk: 'MEDIUM', preapprovedMaxMinor: 1_000n,
  },
  travel_transport: {
    key: 'travel_transport', label: 'Travel & transportation',
    description: 'Flights, lodging, transit, rental cars, rides, parking, or tickets.',
    example: 'Booking a refundable hotel room for an approved trip.',
    permission: 'CONFIRM', risk: 'HIGH',
  },
  physical_goods: {
    key: 'physical_goods', label: 'Physical goods',
    description: 'Office supplies, equipment, replacement parts, groceries, or requested items.',
    example: 'Ordering a replacement charger.',
    permission: 'CONFIRM', risk: 'MEDIUM',
  },
  professional_services: {
    key: 'professional_services', label: 'Professional & human services',
    description: 'Expert advice, transcription, translation, tutoring, design, repair, or contractor work.',
    example: 'Hiring a translator for a document.',
    permission: 'CONFIRM', risk: 'MEDIUM',
  },
  subscriptions_memberships: {
    key: 'subscriptions_memberships', label: 'Subscriptions & memberships',
    description: 'Recurring access to software, publications, communities, storage, or services.',
    example: 'Starting a monthly project-management subscription.',
    permission: 'CONFIRM', risk: 'MEDIUM', recurringCommon: true,
  },
  licenses_permits_fees: {
    key: 'licenses_permits_fees', label: 'Licenses, permits & fees',
    description: 'Application fees, filing fees, registrations, or other official charges.',
    example: 'Paying a government filing fee.',
    permission: 'CONFIRM', risk: 'HIGH',
  },
  testing_validation: {
    key: 'testing_validation', label: 'Testing & validation',
    description: 'Benchmark runs, compatibility tests, domain checks, security scans, or lab services.',
    example: 'Paying to test a prototype against a hosted device fleet.',
    permission: 'PREAPPROVED', risk: 'LOW', preapprovedMaxMinor: 5_000n,
  },
  delivery_fulfillment: {
    key: 'delivery_fulfillment', label: 'Delivery & fulfillment',
    description: 'Shipping, delivery, customs, returns, or fulfillment services.',
    example: 'Paying for expedited shipping.',
    permission: 'PREAPPROVED', risk: 'MEDIUM', preapprovedMaxMinor: 5_000n,
  },
  advertising_promo: {
    key: 'advertising_promo', label: 'Advertising & promotion',
    description: 'Ad placements, sponsored listings, boosted posts, or promotional credits.',
    example: 'Running an approved campaign with a fixed budget.',
    permission: 'CONFIRM', risk: 'HIGH',
  },
  donations_contributions: {
    key: 'donations_contributions', label: 'Donations & contributions',
    description: 'Charitable donations, pledges, or crowdfunding contributions.',
    example: 'Donating a user-approved amount to a named charity.',
    permission: 'CONFIRM', risk: 'HIGH',
  },
  financial_transactions: {
    key: 'financial_transactions', label: 'Financial transactions',
    description: 'Currency conversion, payment processing, invoice settlement, or transfers.',
    example: 'Renewing a domain name before it expires.',
    permission: 'CONFIRM', risk: 'CRITICAL',
  },
  contingency: {
    key: 'contingency', label: 'Contingency purchases',
    description: 'A pre-approved emergency purchase needed to complete a task, under a set spending limit.',
    example: 'Buying a replacement component under a set spending limit.',
    permission: 'CONFIRM', risk: 'HIGH',
  },
};

export const PURCHASE_CATEGORY_KEYS = Object.keys(PURCHASE_CATEGORIES) as PurchaseCategoryKey[];

export function isPurchaseCategory(key: string): key is PurchaseCategoryKey {
  return Object.prototype.hasOwnProperty.call(PURCHASE_CATEGORIES, key);
}

/** A per-agent override an owner set for one category. */
export interface PurchasePolicyOverride {
  permission?: Permission;
  /** For a PREAPPROVED category: the auto-allow ceiling. Above it, the purchase escalates to CONFIRM. */
  maxAmountMinor?: bigint | null;
}

export interface PurchaseContext {
  /** The use-case category. An unknown or missing value is uncategorized: it defers to the
   *  caller's existing gates (mandate, cap, Score), but recurring / paid access / personal
   *  data still force CONFIRM. */
  category?: string | null;
  amountMinor?: bigint;
  recurring?: boolean;
  /** Paid/ongoing access (e.g. a metered endpoint or gated content) — always needs approval. */
  paidAccess?: boolean;
  /** The purchase involves the owner's or a third party's personal data. */
  personalData?: boolean;
}

export interface PolicyDecision {
  category: PurchaseCategoryKey | 'uncategorized';
  permission: Permission;
  risk: RiskClass;
  /** Machine tags explaining the decision, e.g. CATEGORY_PROHIBITED, RECURRING_REQUIRES_APPROVAL. */
  reasons: string[];
}

const RANK: Record<Permission, number> = { PREAPPROVED: 0, CONFIRM: 1, PROHIBITED: 2 };
const escalate = (a: Permission, b: Permission): Permission => (RANK[a] >= RANK[b] ? a : b);

/**
 * Resolve the permission for one purchase. Pure: pass the owner's override for this
 * category (if any). PROHIBITED only ever comes from a category default or an override,
 * never from an escalation; recurring / paid access / personal data can only raise a
 * PREAPPROVED to CONFIRM.
 */
export function resolvePurchasePolicy(ctx: PurchaseContext, override?: PurchasePolicyOverride): PolicyDecision {
  const reasons: string[] = [];
  const key = ctx.category && isPurchaseCategory(ctx.category) ? ctx.category : 'uncategorized';
  const cat = key === 'uncategorized' ? null : PURCHASE_CATEGORIES[key];
  if (key === 'uncategorized') reasons.push('UNCATEGORIZED');

  // Baseline: the override's permission wins over the category default. An uncategorized
  // purchase has no category policy, so it starts PREAPPROVED and defers to the caller's
  // own gates (mandate, per-tx cap, Score bond) — the escalations below still apply.
  let permission: Permission = override?.permission ?? cat?.permission ?? 'PREAPPROVED';
  const risk: RiskClass = cat?.risk ?? 'MEDIUM';
  if (override?.permission) reasons.push('OWNER_OVERRIDE');

  if (permission === 'PROHIBITED') {
    reasons.unshift('CATEGORY_PROHIBITED');
    return { category: key, permission, risk, reasons };
  }

  // A PREAPPROVED purchase over its auto-allow ceiling escalates to CONFIRM. The owner's
  // per-category cap (if set) takes precedence over the category default ceiling.
  if (permission === 'PREAPPROVED' && ctx.amountMinor !== undefined) {
    const limit = override && 'maxAmountMinor' in override ? override.maxAmountMinor ?? undefined : cat?.preapprovedMaxMinor;
    if (limit !== undefined && ctx.amountMinor > limit) {
      permission = escalate(permission, 'CONFIRM');
      reasons.push('OVER_PREAPPROVED_LIMIT');
    }
  }

  // Recurring, paid access and personal data always need an explicit human yes.
  if (ctx.recurring) { permission = escalate(permission, 'CONFIRM'); reasons.push('RECURRING_REQUIRES_APPROVAL'); }
  if (ctx.paidAccess) { permission = escalate(permission, 'CONFIRM'); reasons.push('PAID_ACCESS_REQUIRES_APPROVAL'); }
  if (ctx.personalData || cat?.personalData) { permission = escalate(permission, 'CONFIRM'); reasons.push('PERSONAL_DATA_REQUIRES_APPROVAL'); }

  return { category: key, permission, risk, reasons };
}
