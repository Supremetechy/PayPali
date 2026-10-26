export type Currency = 'USD' | 'EUR' | 'GBP' | 'CAD';

export type PaymentIntentStatus =
  | 'CREATED'
  | 'EVALUATING_POLICY'
  | 'REJECTED'
  | 'PENDING_APPROVAL'
  | 'RESERVED'
  | 'SUBMITTING'
  | 'SETTLED'
  | 'FAILED'
  | 'CANCELLED'
  | 'AMBIGUOUS_PENDING_RECONCILIATION';

export interface Money {
  amount: bigint; // Minor units (e.g., cents: 1000 = $10.00) to prevent floating-point errors
  currency: Currency;
}

export type ObjectiveType = 'GROWTH' | 'SUSTAIN' | 'MAINTAIN';

export type AgentOrigin = 'HUMAN_ONBOARDED' | 'GENERATED';

export type SeedStatus = 'AUTHORIZED' | 'CONSUMED' | 'EXPIRED' | 'REVOKED';

/** The definitive objective a human assigns an agent during onboarding. */
export interface AgentObjective {
  type: ObjectiveType;
  mandate: string; // One-sentence growth/sustain/maintain statement from the human.
  target?: Money; // Optional numeric target the mandate aims at.
}

export interface AgentIdentity {
  id: string;
  ownerId: string;
  name: string;
  isActive: boolean;
  objective?: AgentObjective;
  origin: AgentOrigin;
  createdAt: Date;
}

export interface Seed {
  id: string;
  ownerId: string;
  agentId: string;
  amount: Money;
  fundingSourceReference: string;
  status: SeedStatus;
  policyVersion: number;
  authorizedAt: Date;
  expiresAt?: Date;
}

export interface PolicyRuleSet {
  id: string;
  version: number;
  ownerId: string;
  maxPerTransaction: Money;
  maxDailyBudget: Money;
  maxMonthlyBudget: Money;
  allowedMerchantCategories: string[];
  allowedRecipients: string[]; // Whitelist of recipient/merchant IDs
  requireHumanApprovalAbove: Money;
  updatedAt: Date;
}

export interface SpendReservation {
  id: string;
  agentId: string;
  intentId: string;
  amount: Money;
  status: 'ACTIVE' | 'RELEASED' | 'COMMITTED';
  expiresAt: Date;
  createdAt: Date;
}

export interface PaymentIntent {
  id: string;
  idempotencyKey: string;
  agentId: string;
  ownerId: string;
  recipientId: string;
  merchantCategoryCode?: string;
  amount: Money;
  status: PaymentIntentStatus;
  policyVersionApplied: number;
  paymentMethodRef?: string;
  approvalId?: string;
  providerTransactionId?: string;
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface HumanApproval {
  id: string;
  intentId: string;
  ownerId: string;
  policyVersion: number;
  fingerprint: string; // SHA-256 of intent details to prevent tampering
  approvedAt: Date;
}

export interface AuditRecord {
  id: string;
  traceId: string;
  actorId: string;
  actorType: 'AGENT' | 'OWNER' | 'SYSTEM' | 'RECONCILIATION_WORKER';
  action: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}