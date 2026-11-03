import { PrismaClient, RiskClass } from '@prisma/client';
import { CAPABILITY_RISK } from './scoring';

// ---------------------------------------------------------------------------
// Procedures live in SKILLS; tool access lives in CAPABILITY GRANTS.
//
//  * A skill is a versioned, ordered procedure plus the capabilities it needs
//    and its inherent risk. New definitions bump the version; old versions stay.
//  * A capability is granted explicitly by the owner, up to a maximum risk
//    class, optionally expiring, and revocable with immediate effect.
//  * Binding a skill does NOT grant its capabilities — both are checked at the
//    score gate, so a procedure can never smuggle in tool access.
// ---------------------------------------------------------------------------

export const KNOWN_CAPABILITIES = Object.keys(CAPABILITY_RISK);

export interface SkillInput {
  name: string;
  description?: string;
  steps: string[];
  requiredCapabilities: string[];
  riskClass?: RiskClass;
}

export class SkillService {
  constructor(private readonly prisma: PrismaClient, private readonly now: () => Date = () => new Date()) {}

  async defineSkill(ownerId: string, s: SkillInput) {
    if (!s?.name?.trim()) throw new Error('SKILL_NAME_REQUIRED');
    if (!Array.isArray(s.steps) || !s.steps.length || s.steps.some((x) => typeof x !== 'string' || !x.trim())) {
      throw new Error('SKILL_STEPS_REQUIRED');
    }
    if (!Array.isArray(s.requiredCapabilities)) throw new Error('SKILL_CAPABILITIES_REQUIRED');
    for (const c of s.requiredCapabilities) this.assertCapability(c);
    const latest = await this.prisma.skillDefinition.findFirst({ where: { ownerId, name: s.name.trim() }, orderBy: { version: 'desc' } });
    return this.prisma.skillDefinition.create({
      data: {
        ownerId,
        name: s.name.trim(),
        version: (latest?.version ?? 0) + 1,
        description: s.description ?? '',
        steps: s.steps,
        requiredCapabilities: s.requiredCapabilities,
        riskClass: s.riskClass ?? 'LOW',
      },
    });
  }

  async bindSkill(ownerId: string, agentId: string, skillId: string) {
    const [skill, agent] = await Promise.all([
      this.prisma.skillDefinition.findUnique({ where: { id: skillId } }),
      this.prisma.agent.findUnique({ where: { id: agentId } }),
    ]);
    if (!skill || skill.ownerId !== ownerId) throw new Error('SKILL_NOT_OWNED');
    if (!agent || agent.ownerId !== ownerId) throw new Error('AGENT_NOT_OWNED');
    return this.prisma.agentSkillBinding.upsert({ where: { agentId_skillId: { agentId, skillId } }, update: {}, create: { agentId, skillId } });
  }

  async grantCapability(ownerId: string, agentId: string, capability: string, maxRisk: RiskClass = 'LOW', expiresAt?: Date) {
    this.assertCapability(capability);
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.ownerId !== ownerId) throw new Error('AGENT_NOT_OWNED');
    return this.prisma.capabilityGrant.upsert({
      where: { agentId_capability: { agentId, capability } },
      update: { maxRisk, expiresAt: expiresAt ?? null, revokedAt: null, grantedBy: ownerId },
      create: { agentId, capability, maxRisk, expiresAt, grantedBy: ownerId },
    });
  }

  async revokeCapability(ownerId: string, agentId: string, capability: string) {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.ownerId !== ownerId) throw new Error('AGENT_NOT_OWNED');
    const r = await this.prisma.capabilityGrant.updateMany({ where: { agentId, capability, revokedAt: null }, data: { revokedAt: this.now() } });
    if (!r.count) throw new Error('GRANT_NOT_FOUND');
    return { revoked: capability };
  }

  async capabilitiesFor(agentId: string) {
    const now = this.now();
    return this.prisma.capabilityGrant.findMany({
      where: { agentId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { capability: true, maxRisk: true, expiresAt: true },
    });
  }

  async skillsFor(agentId: string) {
    const b = await this.prisma.agentSkillBinding.findMany({ where: { agentId }, include: { skill: true } });
    return b.map(({ skill }) => ({
      id: skill.id, name: skill.name, version: skill.version, description: skill.description,
      steps: skill.steps as string[], requiredCapabilities: skill.requiredCapabilities, riskClass: skill.riskClass,
    }));
  }

  private assertCapability(c: string) {
    if (!KNOWN_CAPABILITIES.includes(c)) throw new Error(`UNKNOWN_CAPABILITY:${c}`);
  }
}
