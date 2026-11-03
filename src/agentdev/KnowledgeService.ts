import { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Knowledge lives in MODULES, not in model weights.
//
//  * Facts are user-provided and every fact carries a mandatory `source`
//    (provenance). Agents may PROPOSE facts; only the owner can activate them.
//  * Scope is explicit: an agent sees ACTIVE, unexpired facts from modules the
//    owner bound to it — nothing else, never another owner's modules.
//  * Facts are versioned by supersession, never edited in place, so what an
//    agent knew at the time of an action stays reconstructible.
// ---------------------------------------------------------------------------

export interface FactInput {
  statement: string;
  source: string;
  tags?: string[];
  expiresAt?: Date;
}

export interface RetrievedFact {
  id: string;
  module: string;
  statement: string;
  source: string;
  tags: string[];
  relevance: number;
}

const MAX_STATEMENT = 1000;
const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9$%.]+/).filter((t) => t.length > 2));

export class KnowledgeService {
  constructor(private readonly prisma: PrismaClient, private readonly now: () => Date = () => new Date()) {}

  createModule(ownerId: string, name: string, description = '') {
    if (!name?.trim()) throw new Error('MODULE_NAME_REQUIRED');
    return this.prisma.knowledgeModule.create({ data: { ownerId, name: name.trim(), description } });
  }

  async addFact(ownerId: string, moduleId: string, f: FactInput) {
    await this.ownedModule(ownerId, moduleId);
    return this.prisma.knowledgeFact.create({ data: { moduleId, ...this.clean(f), status: 'ACTIVE' } });
  }

  /** An agent may suggest knowledge; it stays PROPOSED until the owner approves. */
  async proposeFact(agentId: string, moduleId: string, f: FactInput) {
    const bound = await this.prisma.agentModuleBinding.findUnique({ where: { agentId_moduleId: { agentId, moduleId } } });
    if (!bound) throw new Error('MODULE_NOT_BOUND');
    return this.prisma.knowledgeFact.create({ data: { moduleId, ...this.clean(f), status: 'PROPOSED', proposedByAgentId: agentId } });
  }

  async approveFact(ownerId: string, factId: string) {
    const fact = await this.ownedFact(ownerId, factId);
    if (fact.status !== 'PROPOSED') throw new Error('FACT_NOT_PROPOSED');
    return this.prisma.knowledgeFact.update({ where: { id: factId }, data: { status: 'ACTIVE' } });
  }

  /** Replace a fact with a corrected version; the old one is kept as SUPERSEDED. */
  async supersedeFact(ownerId: string, factId: string, f: FactInput) {
    const old = await this.ownedFact(ownerId, factId);
    if (old.status !== 'ACTIVE') throw new Error('FACT_NOT_ACTIVE');
    return this.prisma.$transaction(async (tx) => {
      const next = await tx.knowledgeFact.create({ data: { moduleId: old.moduleId, ...this.clean(f), status: 'ACTIVE' } });
      await tx.knowledgeFact.update({ where: { id: factId }, data: { status: 'SUPERSEDED', supersededById: next.id } });
      return next;
    });
  }

  async retireFact(ownerId: string, factId: string) {
    await this.ownedFact(ownerId, factId);
    return this.prisma.knowledgeFact.update({ where: { id: factId }, data: { status: 'RETIRED' } });
  }

  async bindModule(ownerId: string, agentId: string, moduleId: string) {
    await this.ownedModule(ownerId, moduleId);
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.ownerId !== ownerId) throw new Error('AGENT_NOT_OWNED');
    return this.prisma.agentModuleBinding.upsert({
      where: { agentId_moduleId: { agentId, moduleId } },
      update: {},
      create: { agentId, moduleId },
    });
  }

  /** Scoped retrieval: ACTIVE, unexpired facts from this agent's bound modules, keyword-ranked. */
  async retrieve(agentId: string, opts: { query?: string; tags?: string[]; limit?: number } = {}): Promise<RetrievedFact[]> {
    const now = this.now();
    const facts = await this.prisma.knowledgeFact.findMany({
      where: {
        status: 'ACTIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        module: { bindings: { some: { agentId } } },
        ...(opts.tags?.length ? { tags: { hasSome: opts.tags } } : {}),
      },
      include: { module: true },
    });
    const q = tokens(opts.query ?? '');
    const ranked = facts
      .map((f) => {
        const t = tokens(f.statement + ' ' + f.tags.join(' '));
        let hits = 0;
        q.forEach((x) => { if (t.has(x)) hits++; });
        return { id: f.id, module: f.module.name, statement: f.statement, source: f.source, tags: f.tags, relevance: q.size ? hits / q.size : 1 };
      })
      .filter((f) => !q.size || f.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, Math.min(opts.limit ?? 20, 100));
    if (ranked.length) {
      await this.prisma.knowledgeFact.updateMany({ where: { id: { in: ranked.map((r) => r.id) } }, data: { lastUsedAt: now } });
    }
    return ranked;
  }

  /** Background-pass hook: ACTIVE facts past expiresAt become RETIRED. */
  async retireExpired(): Promise<number> {
    const r = await this.prisma.knowledgeFact.updateMany({ where: { status: 'ACTIVE', expiresAt: { lte: this.now() } }, data: { status: 'RETIRED' } });
    return r.count;
  }

  private clean(f: FactInput) {
    const statement = String(f?.statement ?? '').trim();
    const source = String(f?.source ?? '').trim();
    if (!statement || statement.length > MAX_STATEMENT) throw new Error('INVALID_FACT_STATEMENT');
    if (!source) throw new Error('FACT_SOURCE_REQUIRED');
    return { statement, source, tags: (f.tags ?? []).map((t) => String(t).toLowerCase()).slice(0, 20), expiresAt: f.expiresAt };
  }

  private async ownedModule(ownerId: string, moduleId: string) {
    const m = await this.prisma.knowledgeModule.findUnique({ where: { id: moduleId } });
    if (!m || m.ownerId !== ownerId) throw new Error('MODULE_NOT_OWNED');
    return m;
  }

  private async ownedFact(ownerId: string, factId: string) {
    const f = await this.prisma.knowledgeFact.findUnique({ where: { id: factId }, include: { module: true } });
    if (!f || f.module.ownerId !== ownerId) throw new Error('FACT_NOT_OWNED');
    return f;
  }
}
