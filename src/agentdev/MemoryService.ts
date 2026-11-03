import { MemoryKind, Prisma, PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Behavior lives in MEMORY. Two writers, separated by kind:
//   BEHAVIOR / PREFERENCE — set by the owner (standing rules and preferences)
//   LESSON                — written only by background passes from settled
//                           score history. Agents cannot write memory directly,
//                           so an agent cannot talk itself out of a lesson.
// Slots are keyed; a pass overwrites its own slot instead of piling up notes.
// ---------------------------------------------------------------------------

export class MemoryService {
  constructor(private readonly prisma: PrismaClient) {}

  async setOwnerMemory(ownerId: string, agentId: string, key: string, content: string, kind: 'BEHAVIOR' | 'PREFERENCE' = 'BEHAVIOR') {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.ownerId !== ownerId) throw new Error('AGENT_NOT_OWNED');
    if (kind !== 'BEHAVIOR' && kind !== 'PREFERENCE') throw new Error('INVALID_MEMORY_KIND');
    return this.write(agentId, `owner:${this.slot(key)}`, kind, content);
  }

  /** System-only: called by background passes. */
  upsertLesson(agentId: string, key: string, content: string, evidence: Record<string, unknown>, weight = 1) {
    return this.write(agentId, `lesson:${this.slot(key)}`, 'LESSON', content, evidence, weight);
  }

  forget(agentId: string, key: string) {
    return this.prisma.agentMemory.deleteMany({ where: { agentId, key } });
  }

  list(agentId: string) {
    return this.prisma.agentMemory.findMany({
      where: { agentId },
      orderBy: [{ weight: 'desc' }, { updatedAt: 'desc' }],
      select: { key: true, kind: true, content: true, weight: true, updatedAt: true },
    });
  }

  private write(agentId: string, key: string, kind: MemoryKind, content: string, evidence?: Record<string, unknown>, weight = 1) {
    const c = String(content ?? '').trim();
    if (!c || c.length > 2000) throw new Error('INVALID_MEMORY_CONTENT');
    const ev = evidence as Prisma.InputJsonValue | undefined;
    return this.prisma.agentMemory.upsert({
      where: { agentId_key: { agentId, key } },
      update: { content: c, kind, weight, evidence: ev },
      create: { agentId, key, kind, content: c, weight, evidence: ev },
    });
  }

  private slot(key: string) {
    const k = String(key ?? '').trim();
    if (!/^[\w.:-]{1,80}$/.test(k)) throw new Error('INVALID_MEMORY_KEY');
    return k;
  }
}
