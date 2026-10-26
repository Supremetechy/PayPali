import {
  AgentOrigin,
  ObjectiveType,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { deriveLimitsFromSeed } from './objectiveProfiles';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** How a human account holder is identified at onboarding. */
export interface OwnerRef {
  email: string;
}

/** The definitive objective the human assigns the agent. */
export interface ObjectiveInput {
  type: ObjectiveType;
  /** One-sentence mandate. Optional for generate (a default is derived). */
  mandate?: string;
  /** Optional numeric target the mandate aims at, in minor units. */
  targetMinor?: bigint;
}

/** The initial, explicitly authorized funding allocation. */
export interface SeedInput {
  amountMinor: bigint;
  currency: string;
  fundingSourceReference: string;
  expiresAt?: Date;
}

/** Explicit spending policy, supplied by the human on the full-control path. */
export interface PolicyLimitsInput {
  maxPerTransactionMinor: bigint;
  maxDailyBudgetMinor: bigint;
  maxMonthlyBudgetMinor: bigint;
  requireHumanApprovalAboveMinor: bigint;
  allowedRecipients: string[];
  allowedCategories: string[];
}

/** "Onboard my agent": the human supplies the objective, seed, and full policy. */
export interface OnboardAgentInput {
  owner: OwnerRef;
  agentName: string;
  objective: ObjectiveInput;
  seed: SeedInput;
  policy: PolicyLimitsInput;
}

/** "Generate an agent": the platform derives name, mandate, and policy limits. */
export interface GenerateAgentInput {
  owner: OwnerRef;
  objective: ObjectiveInput; // mandate optional; a default is derived from type.
  seed: SeedInput;
  agentName?: string; // Optional; auto-named from the objective when absent.
  // Least privilege: a generated agent can transact with no one until the owner
  // authorizes recipients/categories, so these default to empty.
  allowedRecipients?: string[];
  allowedCategories?: string[];
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface OnboardAgentResult {
  ownerId: string;
  agentId: string;
  seedId: string;
  policyVersion: number;
  origin: AgentOrigin;
  objectiveType: ObjectiveType;
  /**
   * Seed funding is queued, not yet captured: the PayPal pull + wallet credit
   * run through SeedFundingWorker so a crash can never lose the capture. The
   * agent starts at a zero balance and becomes spendable once funding settles.
   */
  fundingStatus: 'PENDING';
  derivedPolicy: {
    maxPerTransactionMinor: bigint;
    maxDailyBudgetMinor: bigint;
    maxMonthlyBudgetMinor: bigint;
    requireHumanApprovalAboveMinor: bigint;
    allowedRecipients: string[];
    allowedCategories: string[];
  };
}

// ---------------------------------------------------------------------------
// Internal normalized shape shared by both paths
// ---------------------------------------------------------------------------

interface NormalizedOnboarding {
  ownerEmail: string;
  agentName: string;
  objectiveType: ObjectiveType;
  objectiveMandate: string;
  objectiveTargetMinor: bigint | null;
  seed: {
    amountMinor: bigint;
    currency: string;
    fundingSourceReference: string;
    expiresAt: Date | null;
  };
  policy: PolicyLimitsInput;
}

const MAX_NAME_LENGTH = 120;
const MAX_MANDATE_LENGTH = 500;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const DEFAULT_MANDATES: Record<ObjectiveType, string> = {
  GROWTH:
    'Compound the seed into durable, income-producing assets while remaining in commission.',
  SUSTAIN:
    'Reach and hold self-sustaining operation where delivered value covers cost, remaining in commission.',
  MAINTAIN:
    'Preserve the seed and the agent standing, spending only what it takes to remain in commission.',
};

/**
 * Owner Authorization + Agent Identity onboarding.
 *
 * Creates (or reuses) an owner, registers an agent with a definitive objective,
 * records the owner-authorized seed, and installs the spending policy the ledger
 * will later enforce — all atomically. Fail-closed: any invalid input aborts the
 * whole onboarding before any row is written.
 *
 * The seed is auto-activated, but crash-safely: onboarding durably records the
 * agent, policy, seed (AUTHORIZED), the agent's wallet account, and a
 * SeedFundingOutbox row in one transaction. SeedFundingWorker then captures the
 * seed from the owner's PayPal balance and credits the wallet. If the process
 * dies between commit and capture, the outbox row survives and the capture is
 * retried idempotently — the PayPal balance is never pulled twice, and the
 * agent is never left half-funded.
 *
 * Scope note: in the current data model a Policy is per owner + currency (shared
 * across that owner's agents), so each onboarding creates a new policy VERSION
 * and deactivates the owner's prior active policies for that currency — latest
 * version wins, matching how LedgerService selects the effective policy.
 */
export class OnboardingService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Full-control path: the human supplies the objective, seed, and policy. */
  async onboardAgent(input: OnboardAgentInput): Promise<OnboardAgentResult> {
    const normalized = this.normalizeOnboard(input);
    return this.persist(normalized, AgentOrigin.HUMAN_ONBOARDED, 'AGENT_ONBOARDED');
  }

  /**
   * Generation path: the human picks an objective and funds a seed; the platform
   * derives the agent name, mandate, and spending limits from the objective.
   */
  async generateAgent(input: GenerateAgentInput): Promise<OnboardAgentResult> {
    const normalized = this.normalizeGenerate(input);
    return this.persist(normalized, AgentOrigin.GENERATED, 'AGENT_GENERATED');
  }

  // -------------------------------------------------------------------------
  // Normalization + validation
  // -------------------------------------------------------------------------

  private normalizeOnboard(input: OnboardAgentInput): NormalizedOnboarding {
    const agentName = this.validateAgentName(input.agentName);
    const { type, mandate, targetMinor } = this.validateObjective(
      input.objective,
      /* allowDefaultMandate */ false
    );
    const seed = this.validateSeed(input.seed);
    const policy = this.validateExplicitPolicy(input.policy);

    return {
      ownerEmail: this.validateEmail(input.owner?.email),
      agentName,
      objectiveType: type,
      objectiveMandate: mandate,
      objectiveTargetMinor: targetMinor,
      seed,
      policy,
    };
  }

  private normalizeGenerate(input: GenerateAgentInput): NormalizedOnboarding {
    const { type, mandate, targetMinor } = this.validateObjective(
      input.objective,
      /* allowDefaultMandate */ true
    );
    const seed = this.validateSeed(input.seed);

    const agentName =
      input.agentName !== undefined
        ? this.validateAgentName(input.agentName)
        : `${type.toLowerCase()}-agent-${randomUUID().slice(0, 8)}`;

    const derived = deriveLimitsFromSeed(type, seed.amountMinor);
    const policy: PolicyLimitsInput = {
      ...derived,
      allowedRecipients: this.normalizeAllowlist(input.allowedRecipients ?? []),
      allowedCategories: this.normalizeAllowlist(input.allowedCategories ?? []),
    };

    return {
      ownerEmail: this.validateEmail(input.owner?.email),
      agentName,
      objectiveType: type,
      objectiveMandate: mandate,
      objectiveTargetMinor: targetMinor,
      seed,
      policy,
    };
  }

  private validateEmail(email: string | undefined): string {
    const trimmed = (email ?? '').trim().toLowerCase();
    if (!trimmed || !EMAIL_PATTERN.test(trimmed)) {
      throw new Error('INVALID_OWNER_EMAIL');
    }
    return trimmed;
  }

  private validateAgentName(name: string | undefined): string {
    const trimmed = (name ?? '').trim();
    if (!trimmed || trimmed.length > MAX_NAME_LENGTH) {
      throw new Error('INVALID_AGENT_NAME');
    }
    return trimmed;
  }

  private validateObjective(
    objective: ObjectiveInput | undefined,
    allowDefaultMandate: boolean
  ): { type: ObjectiveType; mandate: string; targetMinor: bigint | null } {
    if (!objective || !(objective.type in ObjectiveType)) {
      throw new Error('INVALID_OBJECTIVE_TYPE');
    }
    const type = objective.type;

    let mandate = (objective.mandate ?? '').trim();
    if (!mandate) {
      if (!allowDefaultMandate) {
        throw new Error('INVALID_OBJECTIVE_MANDATE');
      }
      mandate = DEFAULT_MANDATES[type];
    }
    if (mandate.length > MAX_MANDATE_LENGTH) {
      throw new Error('INVALID_OBJECTIVE_MANDATE');
    }

    let targetMinor: bigint | null = null;
    if (objective.targetMinor !== undefined) {
      if (typeof objective.targetMinor !== 'bigint' || objective.targetMinor < 0n) {
        throw new Error('INVALID_OBJECTIVE_TARGET');
      }
      targetMinor = objective.targetMinor;
    }

    return { type, mandate, targetMinor };
  }

  private validateSeed(seed: SeedInput | undefined): NormalizedOnboarding['seed'] {
    if (!seed) {
      throw new Error('INVALID_SEED');
    }
    if (typeof seed.amountMinor !== 'bigint' || seed.amountMinor <= 0n) {
      throw new Error('INVALID_SEED_AMOUNT');
    }
    if (!CURRENCY_PATTERN.test(seed.currency ?? '')) {
      throw new Error('INVALID_CURRENCY');
    }
    const ref = (seed.fundingSourceReference ?? '').trim();
    if (!ref) {
      throw new Error('INVALID_FUNDING_SOURCE');
    }
    if (seed.expiresAt !== undefined && Number.isNaN(seed.expiresAt.getTime())) {
      throw new Error('INVALID_SEED_EXPIRY');
    }
    return {
      amountMinor: seed.amountMinor,
      currency: seed.currency,
      fundingSourceReference: ref,
      expiresAt: seed.expiresAt ?? null,
    };
  }

  private validateExplicitPolicy(policy: PolicyLimitsInput | undefined): PolicyLimitsInput {
    if (!policy) {
      throw new Error('INVALID_POLICY_LIMITS');
    }
    const { maxPerTransactionMinor, maxDailyBudgetMinor, maxMonthlyBudgetMinor } = policy;
    const approvalAbove = policy.requireHumanApprovalAboveMinor;

    if (
      typeof maxPerTransactionMinor !== 'bigint' ||
      typeof maxDailyBudgetMinor !== 'bigint' ||
      typeof maxMonthlyBudgetMinor !== 'bigint' ||
      typeof approvalAbove !== 'bigint'
    ) {
      throw new Error('INVALID_POLICY_LIMITS');
    }
    // Fail-closed: a non-positive limit is never treated as "unlimited".
    if (
      maxPerTransactionMinor <= 0n ||
      maxDailyBudgetMinor <= 0n ||
      maxMonthlyBudgetMinor <= 0n ||
      approvalAbove < 0n
    ) {
      throw new Error('INVALID_POLICY_LIMITS');
    }
    // Limits must be internally consistent: per-tx <= daily <= monthly.
    if (
      maxPerTransactionMinor > maxDailyBudgetMinor ||
      maxDailyBudgetMinor > maxMonthlyBudgetMinor
    ) {
      throw new Error('INCONSISTENT_POLICY_LIMITS');
    }

    return {
      maxPerTransactionMinor,
      maxDailyBudgetMinor,
      maxMonthlyBudgetMinor,
      requireHumanApprovalAboveMinor: approvalAbove,
      allowedRecipients: this.normalizeAllowlist(policy.allowedRecipients ?? []),
      allowedCategories: this.normalizeAllowlist(policy.allowedCategories ?? []),
    };
  }

  /** Trims, drops empties, and de-duplicates an allowlist deterministically. */
  private normalizeAllowlist(values: string[]): string[] {
    if (!Array.isArray(values)) {
      throw new Error('INVALID_ALLOWLIST');
    }
    const seen = new Set<string>();
    for (const raw of values) {
      if (typeof raw !== 'string') {
        throw new Error('INVALID_ALLOWLIST');
      }
      const trimmed = raw.trim();
      if (trimmed) {
        seen.add(trimmed);
      }
    }
    return [...seen];
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async persist(
    n: NormalizedOnboarding,
    origin: AgentOrigin,
    auditAction: string
  ): Promise<OnboardAgentResult> {
    const ownerId = await this.ensureOwner(n.ownerEmail);

    return this.prisma.$transaction(async (tx) => {
      // Serialize policy-version allocation for this owner (two concurrent
      // onboardings must not collide on the unique (ownerId, version)).
      await tx.$queryRaw`SELECT id FROM "Owner" WHERE id = ${ownerId} FOR UPDATE`;

      const maxVersion = await tx.policy.aggregate({
        where: { ownerId },
        _max: { version: true },
      });
      const nextVersion = (maxVersion._max.version ?? 0) + 1;

      // Latest version wins: retire the owner's prior active policy for this
      // currency so the ledger resolves the newly installed one.
      await tx.policy.updateMany({
        where: { ownerId, currency: n.seed.currency, isActive: true },
        data: { isActive: false },
      });

      const policy = await tx.policy.create({
        data: {
          ownerId,
          version: nextVersion,
          currency: n.seed.currency,
          maxPerTransactionMinor: n.policy.maxPerTransactionMinor,
          maxDailyBudgetMinor: n.policy.maxDailyBudgetMinor,
          maxMonthlyBudgetMinor: n.policy.maxMonthlyBudgetMinor,
          requireHumanApprovalAbove: n.policy.requireHumanApprovalAboveMinor,
          allowedRecipients: n.policy.allowedRecipients,
          allowedCategories: n.policy.allowedCategories,
          isActive: true,
        },
      });

      const agent = await tx.agent.create({
        data: {
          ownerId,
          name: n.agentName,
          isActive: true,
          objectiveType: n.objectiveType,
          objectiveMandate: n.objectiveMandate,
          objectiveTargetMinor: n.objectiveTargetMinor,
          origin,
        },
      });

      // Seed starts AUTHORIZED: the PayPal capture is queued, not yet done.
      const seed = await tx.seed.create({
        data: {
          ownerId,
          agentId: agent.id,
          amountMinor: n.seed.amountMinor,
          currency: n.seed.currency,
          fundingSourceReference: n.seed.fundingSourceReference,
          status: 'AUTHORIZED',
          policyVersion: nextVersion,
          expiresAt: n.seed.expiresAt,
        },
      });

      // The agent's wallet exists immediately at a zero balance; the funding
      // worker credits it once the PayPal capture confirms.
      await tx.agentAccount.create({
        data: {
          agentId: agent.id,
          currency: n.seed.currency,
          availableMinor: 0n,
        },
      });

      // Durable funding job. A stable idempotency key means every retry pulls
      // the owner's PayPal balance at most once.
      await tx.seedFundingOutbox.create({
        data: {
          seedId: seed.id,
          captureIdempotencyKey: `seed-fund:${seed.id}`,
        },
      });

      await tx.auditLog.create({
        data: {
          traceId: agent.id,
          actorId: ownerId,
          actorType: 'OWNER',
          action: auditAction,
          payload: {
            agentId: agent.id,
            origin,
            objectiveType: n.objectiveType,
            policyVersion: nextVersion,
            seedId: seed.id,
            seedAmountMinor: n.seed.amountMinor.toString(),
            currency: n.seed.currency,
            fundingStatus: 'PENDING',
          },
        },
      });

      return {
        ownerId,
        agentId: agent.id,
        seedId: seed.id,
        policyVersion: nextVersion,
        origin,
        objectiveType: n.objectiveType,
        fundingStatus: 'PENDING' as const,
        derivedPolicy: {
          maxPerTransactionMinor: policy.maxPerTransactionMinor,
          maxDailyBudgetMinor: policy.maxDailyBudgetMinor,
          maxMonthlyBudgetMinor: policy.maxMonthlyBudgetMinor,
          requireHumanApprovalAboveMinor: policy.requireHumanApprovalAbove,
          allowedRecipients: policy.allowedRecipients,
          allowedCategories: policy.allowedCategories,
        },
      };
    });
  }

  /**
   * Resolve an owner by email, creating one if absent. Kept outside the main
   * transaction because a unique-violation on concurrent create would otherwise
   * abort the whole onboarding transaction in Postgres.
   */
  private async ensureOwner(email: string): Promise<string> {
    const existing = await this.prisma.owner.findUnique({ where: { email } });
    if (existing) {
      return existing.id;
    }
    try {
      const created = await this.prisma.owner.create({ data: { email } });
      return created.id;
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        const raced = await this.prisma.owner.findUnique({ where: { email } });
        if (raced) {
          return raced.id;
        }
      }
      throw error;
    }
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
    );
  }
}
