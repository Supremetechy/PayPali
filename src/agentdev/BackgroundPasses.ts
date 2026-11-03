import { PrismaClient } from '@prisma/client';
import { KnowledgeService } from './KnowledgeService';
import { MemoryService } from './MemoryService';
import { ScoreService } from './ScoreService';
import { statusFor } from './scoring';

// ---------------------------------------------------------------------------
// Background passes: work that runs between actions, never inside them.
//
//  1. expireStakes     OPEN stakes past deadline settle as EXPIRED losses.
//  2. consolidate      settled stakes -> per-capability LESSON memory:
//                      calibration gap, retry habit, top failure reasons.
//                      This is how behavior is "fine-tuned" — in memory, from
//                      the agent's own scored record, not in weights.
//  3. scoreHealth      re-derive statuses; any SUSPENDED agent is forced inactive.
//  4. knowledgeHygiene expired facts are retired.
//
// Each pass is idempotent; run them on an interval or on demand.
// ---------------------------------------------------------------------------

const WINDOW = 50; // most recent settled stakes per agent considered for lessons
const MIN_SAMPLES = 3;

export interface PassReport {
  expired: number;
  lessonsWritten: number;
  agentsSuspended: number;
  factsRetired: number;
}

export class BackgroundPasses {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly score: ScoreService,
    private readonly memory: MemoryService,
    private readonly knowledge: KnowledgeService
  ) {}

  async runAll(): Promise<PassReport> {
    const expired = await this.score.expireDue();
    const lessonsWritten = await this.consolidate();
    const agentsSuspended = await this.scoreHealth();
    const factsRetired = await this.knowledge.retireExpired();
    return { expired, lessonsWritten, agentsSuspended, factsRetired };
  }

  async consolidate(): Promise<number> {
    const accounts = await this.prisma.agentScore.findMany({ select: { agentId: true } });
    let written = 0;
    for (const { agentId } of accounts) {
      const settled = await this.prisma.scoreStake.findMany({
        where: { agentId, status: { in: ['WON', 'LOST', 'EXPIRED'] } },
        orderBy: { settledAt: 'desc' },
        take: WINDOW,
      });
      const byCap = new Map<string, typeof settled>();
      for (const s of settled) byCap.set(s.capability, [...(byCap.get(s.capability) ?? []), s]);

      for (const [cap, rows] of byCap) {
        if (rows.length < MIN_SAMPLES) continue;
        const n = rows.length;
        const wins = rows.filter((r) => r.status === 'WON').length;
        const rate = Math.round((wins / n) * 100);
        const avgConf = Math.round(rows.reduce((a, r) => a + r.confidencePct, 0) / n);
        const gap = avgConf - rate;
        const net = rows.reduce((a, r) => a + (r.delta ?? 0), 0);
        const stats = { n, wins, ratePct: rate, avgConfidencePct: avgConf, netPoints: net, stakeIds: rows.map((r) => r.id) };

        const calib =
          gap >= 15
            ? `On ${cap}: you succeeded ${wins}/${n} (${rate}%) while declaring ${avgConf}% on average — overconfident by ${gap} points (net ${net} pts). Declare lower confidence, or verify preconditions before acting.`
            : gap <= -15
              ? `On ${cap}: you succeeded ${rate}% while declaring only ${avgConf}% — underconfident by ${-gap} points. Honest higher confidence on these actions earns more.`
              : `On ${cap}: well calibrated (${rate}% actual vs ${avgConf}% declared over ${n} actions, net ${net} pts). Keep the current pre-action checks.`;
        await this.memory.upsertLesson(agentId, `calibration.${cap}`, calib, stats, Math.min(10, Math.abs(gap) >> 3 || 1));
        written++;

        const retried = rows.filter((r) => r.attemptNo > 1).length;
        if (retried / n >= 0.25) {
          await this.memory.upsertLesson(agentId, `retries.${cap}`,
            `On ${cap}: ${retried} of your last ${n} actions were retries, each costing 2x/4x the stake. Make the first attempt the verified one.`,
            { retried, n }, 5);
          written++;
        }

        const reasons = new Map<string, number>();
        for (const r of rows) {
          if (r.status === 'WON') continue;
          const why = String((r.evidence as Record<string, unknown> | null)?.reason ?? (r.status === 'EXPIRED' ? 'EXPIRED_UNVERIFIED' : 'UNSPECIFIED'));
          reasons.set(why, (reasons.get(why) ?? 0) + 1);
        }
        const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
        if (top.length) {
          await this.memory.upsertLesson(agentId, `failures.${cap}`,
            `Most common failure causes on ${cap}: ${top.map(([k, v]) => `${k} (${v}x)`).join(', ')}. Check for these before staking.`,
            Object.fromEntries(top), 4);
          written++;
        }
      }
    }
    return written;
  }

  async scoreHealth(): Promise<number> {
    const accounts = await this.prisma.agentScore.findMany();
    let suspended = 0;
    for (const a of accounts) {
      const status = statusFor(a.balance, a.floor);
      if (status !== a.status) await this.prisma.agentScore.update({ where: { agentId: a.agentId }, data: { status } });
      if (status === 'SUSPENDED') {
        const r = await this.prisma.agent.updateMany({ where: { id: a.agentId, isActive: true }, data: { isActive: false } });
        suspended += r.count;
      }
    }
    return suspended;
  }
}
