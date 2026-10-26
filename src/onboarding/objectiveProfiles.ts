// src/onboarding/objectiveProfiles.ts
//
// Maps a human-assigned objective (GROWTH / SUSTAIN / MAINTAIN) onto a concrete,
// deterministic spending policy derived from the agent's seed. This is the
// mechanical encoding of the Agent-economy ladder:
//
//   MAINTAIN — Phase 1 "preserve capital, don't spend yet". Tight limits, low
//              approval threshold, heavy human oversight.
//   SUSTAIN  — reach and hold V >= C (self-sustaining at near-zero margin).
//              Moderate limits; the agent can transact to stay in commission.
//   GROWTH   — Phase 3+ "compound into leverage". Aggressive limits and a high
//              autonomy threshold so the flywheel can turn without a human in
//              the loop on every reinvestment.
//
// All fractions are expressed in basis points (1 bp = 0.01%) so every derived
// amount is exact bigint arithmetic on the seed's minor units — no floats ever
// touch money. Derivation is pure and side-effect free; OnboardingService owns
// persistence and validation.

import { ObjectiveType } from '../types/domain';

export interface ObjectiveProfile {
  /** Per-transaction ceiling, as basis points of the seed. */
  perTransactionBps: number;
  /** Aggregate daily budget, as basis points of the seed. */
  dailyBudgetBps: number;
  /** Aggregate monthly budget, as basis points of the seed (may exceed 100%). */
  monthlyBudgetBps: number;
  /** Human approval required strictly above this, as basis points of the seed. */
  requireApprovalAboveBps: number;
  /** Human-readable rationale, surfaced in onboarding UIs and audit payloads. */
  rationale: string;
}

const BPS_DENOMINATOR = 10_000n;

// Invariant across every profile: perTx <= daily <= monthly, so the derived
// policy can never be internally contradictory.
export const OBJECTIVE_PROFILES: Readonly<Record<ObjectiveType, ObjectiveProfile>> = {
  MAINTAIN: {
    perTransactionBps: 300, // 3%
    dailyBudgetBps: 800, // 8%
    monthlyBudgetBps: 2_500, // 25%
    requireApprovalAboveBps: 200, // 2% — almost everything is reviewed
    rationale:
      'Preserve capital. Tight per-transaction ceiling and low approval threshold keep the agent in reconnaissance mode (Agent-economy Phase 0-1).',
  },
  SUSTAIN: {
    perTransactionBps: 1_000, // 10%
    dailyBudgetBps: 3_000, // 30%
    monthlyBudgetBps: 10_000, // 100%
    requireApprovalAboveBps: 1_000, // 10%
    rationale:
      'Operate at self-sustaining, near-zero margin. Moderate limits let the agent transact to hold V >= C without burning the seed.',
  },
  GROWTH: {
    perTransactionBps: 2_500, // 25%
    dailyBudgetBps: 6_000, // 60%
    monthlyBudgetBps: 20_000, // 200% — reinvestment can cycle capital within a month
    requireApprovalAboveBps: 2_500, // 25% — high autonomy so the flywheel can turn
    rationale:
      'Compound into leverage. Aggressive limits and a high autonomy threshold let the agent reinvest revenue (Agent-economy Phase 3+).',
  },
};

export interface DerivedPolicyLimits {
  maxPerTransactionMinor: bigint;
  maxDailyBudgetMinor: bigint;
  maxMonthlyBudgetMinor: bigint;
  requireHumanApprovalAboveMinor: bigint;
}

/**
 * Derive concrete spending limits (minor units) from an objective and a seed.
 *
 * `seedMinor` must be a positive bigint; the caller (OnboardingService) is
 * responsible for that validation. Each limit is floored at 1 minor unit so a
 * tiny seed can never collapse a limit to zero and silently fail closed on a
 * legitimately funded agent — except the approval threshold, which is allowed to
 * reach zero (meaning "approve everything").
 */
export function deriveLimitsFromSeed(
  objective: ObjectiveType,
  seedMinor: bigint
): DerivedPolicyLimits {
  const profile = OBJECTIVE_PROFILES[objective];
  if (!profile) {
    throw new Error('UNKNOWN_OBJECTIVE_TYPE');
  }

  const scale = (bps: number): bigint =>
    (seedMinor * BigInt(bps)) / BPS_DENOMINATOR;
  const atLeastOne = (value: bigint): bigint => (value > 0n ? value : 1n);

  return {
    maxPerTransactionMinor: atLeastOne(scale(profile.perTransactionBps)),
    maxDailyBudgetMinor: atLeastOne(scale(profile.dailyBudgetBps)),
    maxMonthlyBudgetMinor: atLeastOne(scale(profile.monthlyBudgetBps)),
    // May legitimately be 0 => every transaction needs human approval.
    requireHumanApprovalAboveMinor: scale(profile.requireApprovalAboveBps),
  };
}
