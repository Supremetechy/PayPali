import { LedgerEntryType, Prisma, PrismaClient, RiskClass, StakeStatus } from '@prisma/client';
import { AgentWalletService } from '../services/AgentWalletService';
import {
  CAPABILITY_RISK,
  MAX_ATTEMPTS,
  Price,
  Risk,
  amountRisk,
  assertConfidence,
  maxRisk,
  price,
  riskAtMost,
  settleDelta,
  statusFor,
} from './scoring';

// ---------------------------------------------------------------------------
// ScoreService — the safety gate every agent action passes through.
//
//   quote()  -> preflight: is this action allowed, and what does it cost on
//               success / failure? Nothing is written. (consequence BEFORE acting)
//   commit() -> lock the worst-case points AND hold the matching wallet bond,
//               atomically, under row locks. Only now may the action run.
//   settle() -> exactly-once binary settlement. Points and money move together:
//               win releases the bond; loss forfeits the lost points' share of
//               the bond to the Score Pool and releases the rest.
//   expire() -> an OPEN stake past its deadline settles as a loss (EXPIRED):
//               an action the agent cannot get verified is a failed action.
//
// Fail-closed: any check that cannot pass returns allowed=false with reasons;
// commit re-checks everything inside the transaction.
// ---------------------------------------------------------------------------

export interface ScoreConfig {
  initialPoints: number;
  floor: number;
  /** Wallet minor units bonded per locked point (USD cents by default). */
  bondMinorPerPoint: bigint;
  /** How long an action has to be verified before it settles as EXPIRED. */
  stakeTtlMs: number;
  poolEmail: string;
}

export const DEFAULT_SCORE_CONFIG: ScoreConfig = {
  initialPoints: 1000,
  floor: 300,
  bondMinorPerPoint: 1n,
  stakeTtlMs: 15 * 60_000,
  poolEmail: 'score-pool@paypali.system',
};

export interface ActionRequest {
  agentId: string;
  capability: string;
  /** Stable identity of the GOAL (not the attempt). Retries reuse it and cost more. */
  intentKey: string;
  confidencePct: number;
  skillId?: string;
  amountMinor?: bigint;
  currency?: string;
  /** Per-action verification deadline (clamped 1 min .. 30 days). Defaults to cfg.stakeTtlMs. */
  ttlMs?: number;
}

const MIN_TTL = 60_000;
const MAX_TTL = 30 * 86_400_000;

export interface Quote extends Price {
  allowed: boolean;
  reasons: string[];
  riskClass: Risk;
  attemptNo: number;
  bondMinor: bigint;
  /** Money that would be forfeited on failure (minor units). */
  bondAtRiskOnFailureMinor: bigint;
  currency: string;
  availablePoints: number;
  scoreStatus: string;
}

export interface Settlement {
  stakeId: string;
  status: StakeStatus;
  delta: number;
  forfeitedMinor: bigint;
  balanceAfter: number;
  scoreStatus: string;
  replayed: boolean;
}

export class ScoreService {
  readonly cfg: ScoreConfig;
  private poolAgentId: string | null = null;
  /** Extra gates checked on every quote (e.g. "a signed Power of Agency is required"). Return reasons to refuse. */
  preconditions: Array<(agentId: string, db: Prisma.TransactionClient | PrismaClient) => Promise<string[]>> = [];

  constructor(
    private readonly prisma: PrismaClient,
    private readonly wallet: AgentWalletService,
    cfg: Partial<ScoreConfig> = {},
    private readonly now: () => Date = () => new Date()
  ) {
    this.cfg = { ...DEFAULT_SCORE_CONFIG, ...cfg };
  }

  /** Open the agent's score account (idempotent). */
  async open(agentId: string, opts: { initialPoints?: number; floor?: number } = {}) {
    const initial = opts.initialPoints ?? this.cfg.initialPoints;
    const floor = opts.floor ?? this.cfg.floor;
    if (!(Number.isInteger(initial) && Number.isInteger(floor) && floor >= 0 && initial > floor)) {
      throw new Error('INVALID_SCORE_CONFIG');
    }
    return this.prisma.agentScore.upsert({
      where: { agentId },
      update: {},
      create: { agentId, balance: initial, floor, status: statusFor(initial, floor) },
    });
  }

  getAccount(agentId: string) {
    return this.prisma.agentScore.findUnique({ where: { agentId } });
  }

  /** The platform account that receives forfeited bonds. Created on first use. */
  async poolAgent(): Promise<string> {
    if (this.poolAgentId) return this.poolAgentId;
    const owner = await this.prisma.owner.upsert({
      where: { email: this.cfg.poolEmail },
      update: {},
      create: { email: this.cfg.poolEmail },
    });
    const existing = await this.prisma.agent.findFirst({ where: { ownerId: owner.id, name: 'PayPali Score Pool' } });
    const agent = existing ?? (await this.prisma.agent.create({ data: { ownerId: owner.id, name: 'PayPali Score Pool' } }));
    this.poolAgentId = agent.id;
    return agent.id;
  }

  // -------------------------------------------------------------------------
  // QUOTE — read-only preflight.
  // -------------------------------------------------------------------------
  async quote(req: ActionRequest, db: Prisma.TransactionClient | PrismaClient = this.prisma): Promise<Quote> {
    const reasons: string[] = [];
    const currency = req.currency ?? 'USD';
    const amountMinor = req.amountMinor ?? 0n;
    assertConfidence(req.confidencePct);
    if (typeof req.intentKey !== 'string' || !req.intentKey.trim() || req.intentKey.length > 200) {
      throw new Error('INTENT_KEY_REQUIRED');
    }
    if (amountMinor < 0n) throw new Error('INVALID_AMOUNT');

    const agent = await db.agent.findUnique({ where: { id: req.agentId } });
    if (!agent) throw new Error('AGENT_NOT_FOUND');
    if (!agent.isActive) reasons.push('AGENT_INACTIVE');
    for (const gate of this.preconditions) reasons.push(...(await gate(req.agentId, db)));

    const account = await db.agentScore.findUnique({ where: { agentId: req.agentId } });
    if (!account) throw new Error('AGENT_NOT_DEVELOPED');
    if (account.status === 'SUSPENDED') reasons.push('SCORE_SUSPENDED');

    // Built capability: explicit, unexpired, unrevoked grant.
    const nowD = this.now();
    const grant = await db.capabilityGrant.findUnique({
      where: { agentId_capability: { agentId: req.agentId, capability: req.capability } },
    });
    const grantLive = grant && !grant.revokedAt && (!grant.expiresAt || grant.expiresAt > nowD);
    if (!grantLive) reasons.push('CAPABILITY_NOT_GRANTED');

    // Procedure: the skill must be bound to this agent and declare this capability.
    let risk: Risk = maxRisk(CAPABILITY_RISK[req.capability] ?? 'MEDIUM', amountRisk(amountMinor));
    if (req.skillId) {
      const binding = await db.agentSkillBinding.findUnique({
        where: { agentId_skillId: { agentId: req.agentId, skillId: req.skillId } },
        include: { skill: true },
      });
      if (!binding) reasons.push('SKILL_NOT_BOUND');
      else {
        if (!binding.skill.requiredCapabilities.includes(req.capability)) reasons.push('SKILL_DOES_NOT_USE_CAPABILITY');
        risk = maxRisk(risk, binding.skill.riskClass as Risk);
      }
    }
    if (grantLive && !riskAtMost(risk, grant!.maxRisk as Risk)) reasons.push('RISK_ABOVE_GRANT');
    if (account.status === 'PROBATION' && risk !== 'LOW') reasons.push('PROBATION_LOW_RISK_ONLY');

    // One attempt should be enough: retries escalate, then stop.
    const prior = await db.scoreStake.findMany({
      where: { agentId: req.agentId, intentKey: req.intentKey },
      select: { status: true },
    });
    if (prior.some((s) => s.status === 'WON')) reasons.push('INTENT_ALREADY_ACHIEVED');
    if (prior.some((s) => s.status === 'OPEN')) reasons.push('ATTEMPT_IN_FLIGHT');
    const attemptNo = prior.length + 1;
    if (attemptNo > MAX_ATTEMPTS) reasons.push('ATTEMPTS_EXHAUSTED');

    const pr = price({ risk, attemptNo: Math.min(attemptNo, MAX_ATTEMPTS), confidencePct: req.confidencePct, amountMinor });
    const availablePoints = account.balance - account.lockedPoints;
    if (pr.lockedPoints > availablePoints) reasons.push('INSUFFICIENT_SCORE');
    // Deliberately NO "worst case must stay above floor" rule: losses that cross
    // the floor are exactly what trips SUSPENDED — the kill switch must be reachable.

    const bondMinor = BigInt(pr.lockedPoints) * this.cfg.bondMinorPerPoint;
    // Read through `db` (may be the commit transaction) — never a second connection.
    const walletAcct = await db.agentAccount.findUnique({ where: { agentId_currency: { agentId: req.agentId, currency } } });
    const walletAvailable = walletAcct?.availableMinor ?? 0n;
    if (walletAvailable < bondMinor + amountMinor) reasons.push('INSUFFICIENT_FUNDS_FOR_BOND');

    return {
      ...pr,
      allowed: reasons.length === 0,
      reasons,
      riskClass: risk,
      attemptNo,
      bondMinor,
      bondAtRiskOnFailureMinor: BigInt(Math.max(0, -pr.onFailure)) * this.cfg.bondMinorPerPoint,
      currency,
      availablePoints,
      scoreStatus: account.status,
    };
  }

  // -------------------------------------------------------------------------
  // COMMIT — lock points + hold bond. Returns the OPEN stake.
  // -------------------------------------------------------------------------
  async commit(req: ActionRequest): Promise<{ stakeId: string; quote: Quote }> {
    const currency = req.currency ?? 'USD';
    await this.wallet.ensureAccount(req.agentId, currency);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "agentId" FROM "AgentScore" WHERE "agentId" = ${req.agentId} FOR UPDATE`;
        const q = await this.quote(req, tx);
        if (!q.allowed) throw Object.assign(new Error('ACTION_NOT_ALLOWED'), { quote: q });

        const stake = await tx.scoreStake.create({
          data: {
            agentId: req.agentId,
            intentKey: req.intentKey,
            attemptNo: q.attemptNo,
            capability: req.capability,
            skillId: req.skillId,
            riskClass: q.riskClass as RiskClass,
            confidencePct: req.confidencePct,
            stake: q.stake,
            fee: q.fee,
            lockedPoints: q.lockedPoints,
            expiresAt: new Date(this.now().getTime() + Math.min(MAX_TTL, Math.max(MIN_TTL, req.ttlMs ?? this.cfg.stakeTtlMs))),
          },
        });
        await tx.agentScore.update({
          where: { agentId: req.agentId },
          data: { lockedPoints: { increment: q.lockedPoints } },
        });
        if (q.bondMinor > 0n) {
          await this.wallet.holdTx(tx, { agentId: req.agentId, amountMinor: q.bondMinor, currency, intentId: bondId(stake.id) });
        }
        await this.audit(tx, req.agentId, 'SCORE_STAKE_COMMITTED', {
          stakeId: stake.id, intentKey: req.intentKey, attemptNo: q.attemptNo, capability: req.capability,
          risk: q.riskClass, confidencePct: req.confidencePct, stake: q.stake, lockedPoints: q.lockedPoints,
          bondMinor: q.bondMinor.toString(), currency,
        });
        return { stakeId: stake.id, quote: q };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new Error('ATTEMPT_IN_FLIGHT');
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // SETTLE — binary, exactly once. evidence is stored verbatim for passes.
  // -------------------------------------------------------------------------
  async settle(stakeId: string, outcome: { success: boolean; evidence?: Record<string, unknown> }, expired = false): Promise<Settlement> {
    if (typeof outcome?.success !== 'boolean') throw new Error('OUTCOME_MUST_BE_BOOLEAN');
    const poolId = await this.poolAgent();
    const pre = await this.prisma.scoreStake.findUnique({ where: { id: stakeId } });
    if (!pre) throw new Error('STAKE_NOT_FOUND');
    const currency = await this.bondCurrency(stakeId);
    await this.wallet.ensureAccount(poolId, currency);

    return this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ status: StakeStatus }>>`
        SELECT status FROM "ScoreStake" WHERE id = ${stakeId} FOR UPDATE`;
      const s = await tx.scoreStake.findUniqueOrThrow({ where: { id: stakeId } });
      const acct0 = await tx.agentScore.findUniqueOrThrow({ where: { agentId: s.agentId } });
      if (row.status !== 'OPEN') {
        return { stakeId, status: s.status, delta: s.delta ?? 0, forfeitedMinor: 0n, balanceAfter: acct0.balance, scoreStatus: acct0.status, replayed: true };
      }
      await tx.$queryRaw`SELECT "agentId" FROM "AgentScore" WHERE "agentId" = ${s.agentId} FOR UPDATE`;

      const success = expired ? false : outcome.success;
      const delta = Math.max(-s.lockedPoints, settleDelta(s.stake, s.fee, s.confidencePct, success));
      const status: StakeStatus = expired ? 'EXPIRED' : success ? 'WON' : 'LOST';
      const balance = acct0.balance + delta;
      const scoreStatus = statusFor(balance, acct0.floor);

      await tx.scoreStake.update({
        where: { id: stakeId },
        data: { status, delta, settledAt: this.now(), evidence: (outcome.evidence ?? {}) as Prisma.InputJsonValue },
      });
      await tx.agentScore.update({
        where: { agentId: s.agentId },
        data: {
          balance,
          lockedPoints: { decrement: s.lockedPoints },
          status: scoreStatus,
          ...(success ? { wins: { increment: 1 } } : { losses: { increment: 1 } }),
        },
      });

      // Money follows points: forfeit the lost share of the bond, release the rest.
      const bond = BigInt(s.lockedPoints) * this.cfg.bondMinorPerPoint;
      const forfeited = BigInt(Math.max(0, -delta)) * this.cfg.bondMinorPerPoint;
      const hold = { agentId: s.agentId, currency, intentId: bondId(stakeId) };
      if (forfeited > 0n) {
        await this.wallet.commitHoldTx(tx, { ...hold, amountMinor: forfeited });
        await this.wallet.creditTx(tx, {
          agentId: poolId, currency, amountMinor: forfeited, type: LedgerEntryType.SCORE_FORFEIT,
          idempotencyKey: `forfeit:${stakeId}`, relatedIntentId: bondId(stakeId),
        });
      }
      if (bond - forfeited > 0n) await this.wallet.releaseHoldTx(tx, { ...hold, amountMinor: bond - forfeited });

      // Safety: a suspended score switches the agent off for ALL money movement.
      if (scoreStatus === 'SUSPENDED') {
        await tx.agent.update({ where: { id: s.agentId }, data: { isActive: false } });
      }
      await this.audit(tx, s.agentId, 'SCORE_STAKE_SETTLED', {
        stakeId, status, success, delta, balanceAfter: balance, scoreStatus, forfeitedMinor: forfeited.toString(),
      });
      return { stakeId, status, delta, forfeitedMinor: forfeited, balanceAfter: balance, scoreStatus, replayed: false };
    });
  }

  /** Settle every OPEN stake past its deadline as EXPIRED (a loss). */
  async expireDue(): Promise<number> {
    const due = await this.prisma.scoreStake.findMany({
      where: { status: 'OPEN', expiresAt: { lt: this.now() } },
      select: { id: true },
      take: 500,
    });
    for (const d of due) await this.settle(d.id, { success: false, evidence: { reason: 'EXPIRED_UNVERIFIED' } }, true);
    return due.length;
  }

  private async bondCurrency(stakeId: string): Promise<string> {
    const hold = await this.prisma.ledgerEntry.findUnique({ where: { idempotencyKey: `hold:${bondId(stakeId)}` } });
    return hold?.currency ?? 'USD';
  }

  private audit(tx: Prisma.TransactionClient, agentId: string, action: string, payload: Record<string, unknown>) {
    return tx.auditLog.create({
      data: { traceId: agentId, actorId: agentId, actorType: 'SYSTEM', action, payload: payload as Prisma.InputJsonValue },
    });
  }
}

export const bondId = (stakeId: string) => `score:${stakeId}`;
