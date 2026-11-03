import { PrismaClient } from '@prisma/client';
import { AgentWalletService } from '../services/AgentWalletService';
import { BackgroundPasses } from './BackgroundPasses';
import { KnowledgeService } from './KnowledgeService';
import { MemoryService } from './MemoryService';
import { ScoreConfig, ScoreService } from './ScoreService';
import { ScoredExecutor } from './ScoredExecutor';
import { SkillService } from './SkillService';
import { MAX_ATTEMPTS, RISK_BASE } from './scoring';

// ---------------------------------------------------------------------------
// Agent Development function — one entry point that composes:
//   knowledge (modules) · procedures (skills) · built capability (grants)
//   behavior (memory)   · safety (score)      · background passes
//
// develop() turns an existing PayPali agent into a developed agent by opening
// its score account. context() is what an agent runtime puts in front of the
// model for a task: every field is data the owner provided or the agent's own
// scored record produced — nothing comes from model weights.
// ---------------------------------------------------------------------------

export class AgentDevService {
  readonly knowledge: KnowledgeService;
  readonly skills: SkillService;
  readonly memory: MemoryService;
  readonly score: ScoreService;
  readonly executor: ScoredExecutor;
  readonly passes: BackgroundPasses;

  constructor(private readonly prisma: PrismaClient, wallet: AgentWalletService, scoreCfg: Partial<ScoreConfig> = {}, now: () => Date = () => new Date()) {
    this.knowledge = new KnowledgeService(prisma, now);
    this.skills = new SkillService(prisma, now);
    this.memory = new MemoryService(prisma);
    this.score = new ScoreService(prisma, wallet, scoreCfg, now);
    this.executor = new ScoredExecutor(this.score);
    this.passes = new BackgroundPasses(prisma, this.score, this.memory, this.knowledge);
  }

  async develop(ownerId: string, agentId: string, opts: { initialPoints?: number; floor?: number } = {}) {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.ownerId !== ownerId) throw new Error('AGENT_NOT_OWNED');
    return this.score.open(agentId, opts);
  }

  async context(agentId: string, opts: { query?: string; tags?: string[]; limit?: number } = {}) {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new Error('AGENT_NOT_FOUND');
    const [score, capabilities, skills, knowledge, memory, open] = await Promise.all([
      this.score.getAccount(agentId),
      this.skills.capabilitiesFor(agentId),
      this.skills.skillsFor(agentId),
      this.knowledge.retrieve(agentId, opts),
      this.memory.list(agentId),
      this.prisma.scoreStake.count({ where: { agentId, status: 'OPEN' } }),
    ]);
    if (!score) throw new Error('AGENT_NOT_DEVELOPED');
    return {
      agent: { id: agent.id, name: agent.name, isActive: agent.isActive, objective: agent.objectiveMandate },
      score: {
        balance: score.balance, locked: score.lockedPoints, available: score.balance - score.lockedPoints,
        floor: score.floor, status: score.status, wins: score.wins, losses: score.losses, openStakes: open,
        bondMinorPerPoint: this.score.cfg.bondMinorPerPoint,
      },
      rules: {
        summary: 'Every action is quoted before it runs and must be staked with points backed by a wallet bond. Declare your honest P(success) as confidencePct (1-99). Success returns the bond plus a calibration reward; failure burns points and forfeits the matching bond. Hedging at 50% always costs the fee. Retries of the same intentKey double the stake; at most ' + MAX_ATTEMPTS + ' attempts.',
        riskBase: RISK_BASE,
      },
      capabilities,
      skills,
      knowledge,
      memory,
    };
  }
}
