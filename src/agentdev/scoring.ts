// ---------------------------------------------------------------------------
// Score math — pure, deterministic, unit-testable. No I/O.
//
// Every scored action is priced BEFORE it runs:
//
//   stake  = (RISK_BASE[risk] + floor(amountMinor / 1000)) * 2^(attempt-1)
//   fee    = ceil(stake / 10)                       always burned: acting costs something
//   p      = confidencePct / 100                    agent's declared P(success), 0.01..0.99
//   S      = 1 - (outcome - p)^2                    Brier score, outcome ∈ {0,1}
//   delta  = round(4 * stake * (S - 0.75)) - fee    net points on settlement
//   locked = fee + ceil(4 * stake * max(0, p² - 0.25))   = worst-case loss, held up front
//
// Properties this buys:
//  * Proper scoring rule (for p >= 0.5): expected delta is maximized by
//    reporting your TRUE success probability — overclaiming is punished.
//    Failure gains are clipped to 0, so below p = 0.5 every action has negative
//    expectation: if you think you'll fail, don't act.
//  * p = 0.5 ("I don't know") nets exactly -fee either way: hedging never pays.
//  * Confident failure is the most expensive outcome (p=0.9 fail ≈ -2.34·stake).
//  * Retries double the stake each time and stop after MAX_ATTEMPTS, so the
//    first attempt is the one that should be right.
//  * locked covers the worst case, so a stake can never drive the balance
//    below what was available at commit time.
//
// Money: points are backed 1:1 by a wallet bond of BOND_MINOR_PER_POINT minor
// units per locked point. Forfeited points forfeit the same share of the bond.
// ---------------------------------------------------------------------------

export type Risk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export const RISK_ORDER: Risk[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const RISK_BASE: Record<Risk, number> = { LOW: 10, MEDIUM: 40, HIGH: 120, CRITICAL: 300 };
export const MAX_ATTEMPTS = 3;

/** Default inherent risk of each built capability. Unknown capabilities are MEDIUM. */
export const CAPABILITY_RISK: Record<string, Risk> = {
  'wallet.send': 'MEDIUM',
  'wallet.pay': 'MEDIUM',
  'bazaar.purchase': 'MEDIUM',
  'wallet.payout': 'HIGH',
  'wallet.checkout': 'HIGH',
  'knowledge.propose': 'LOW',
  'market.service': 'MEDIUM', // paying a marketplace service in Gas (Netflix, Uber, ...)
  'data.query': 'LOW',         // buying an answer from a company data agent
  'data.answer': 'MEDIUM',     // a company data agent staking on the accuracy of an answer it sold
  'skill.use': 'MEDIUM',       // calling a skill another agent sells (paid in Gas)
  'skill.sell': 'MEDIUM',      // selling skills to other agents
};

export const maxRisk = (...r: Risk[]): Risk => RISK_ORDER[Math.max(...r.map((x) => RISK_ORDER.indexOf(x)))];
export const riskAtMost = (r: Risk, limit: Risk): boolean => RISK_ORDER.indexOf(r) <= RISK_ORDER.indexOf(limit);

/** Money moved escalates risk regardless of what the capability is. */
export function amountRisk(amountMinor: bigint): Risk {
  if (amountMinor >= 100_000n) return 'CRITICAL'; // >= $1,000
  if (amountMinor >= 10_000n) return 'HIGH'; //      >= $100
  if (amountMinor > 0n) return 'MEDIUM';
  return 'LOW';
}

export interface PriceInput {
  risk: Risk;
  attemptNo: number;
  confidencePct: number;
  amountMinor: bigint;
}

export interface Price {
  stake: number;
  fee: number;
  lockedPoints: number;
  /** Net points if the action succeeds / fails — the consequence, shown before acting. */
  onSuccess: number;
  onFailure: number;
}

export function assertConfidence(c: unknown): number {
  if (typeof c !== 'number' || !Number.isInteger(c) || c < 1 || c > 99) {
    throw new Error('CONFIDENCE_MUST_BE_INT_1_TO_99');
  }
  return c;
}

export function price(i: PriceInput): Price {
  const p = assertConfidence(i.confidencePct) / 100;
  const amountPts = Number(i.amountMinor > 0n ? i.amountMinor / 1000n : 0n);
  const stake = (RISK_BASE[i.risk] + amountPts) * 2 ** (i.attemptNo - 1);
  const fee = Math.ceil(stake / 10);
  const lockedPoints = fee + Math.ceil(4 * stake * Math.max(0, p * p - 0.25));
  return { stake, fee, lockedPoints, onSuccess: settleDelta(stake, fee, i.confidencePct, true), onFailure: settleDelta(stake, fee, i.confidencePct, false) };
}

export function settleDelta(stake: number, fee: number, confidencePct: number, success: boolean): number {
  const p = confidencePct / 100;
  const o = success ? 1 : 0;
  const brier = Math.round(4 * stake * (1 - (o - p) ** 2 - 0.75));
  // A failed action never earns points, even when the agent predicted the
  // failure — otherwise "act, expecting to fail" would be a farming strategy.
  return (success ? brier : Math.min(0, brier)) - fee;
}

export type ScoreState = 'ACTIVE' | 'PROBATION' | 'SUSPENDED';
/** At/below floor: suspended. Within 50% above floor: probation (LOW risk only). */
export function statusFor(balance: number, floor: number): ScoreState {
  if (balance <= floor) return 'SUSPENDED';
  if (balance < Math.ceil(floor * 1.5)) return 'PROBATION';
  return 'ACTIVE';
}
