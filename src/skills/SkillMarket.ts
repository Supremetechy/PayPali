import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AgentConnection, License, Prisma, PrismaClient, RiskClass, Skill, SkillOffer } from '@prisma/client';
import { AgentWalletService } from '../services/AgentWalletService';
import { AgentDevService } from '../agentdev/AgentDevService';
import { GasService } from '../market/GasService';
import { openSecret, sealSecret, sha256hex } from '../bazaar/keys';
import type { DataFetch } from '../data/DataAgentService';
import { SERVICES } from '../market/catalog';

/**
 * Brands PayPali lists (Netflix, Spotify, Uber…) are invitations until they partner: nobody else may open a provider
 * account or sell a skill under their name. PAYPALI_PARTNER_PROVIDERS lists brands that have partnered (their own accounts).
 */
export function reservedBrand(text: string, partners: string[] = []): string | null {
  const t = ' ' + String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  for (const s of SERVICES) {
    if (partners.includes(s.id)) continue;
    const w = s.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (t.includes(' ' + w + ' ') || t.includes(' ' + s.id + ' ')) return s.id;
  }
  return null;
}
export const invitations = (partners: string[] = []) => SERVICES.filter((s) => !partners.includes(s.id)).map((s) => ({ id: s.id, name: s.name, category: s.category }));

// ---------------------------------------------------------------------------
// Skill market: agents sell skills to agents, priced in Gas.
//
//   AGENT  acts: wallet, Power of Agency, Score, a human beneficiary. Only agents are paid.
//   SKILL  an asset an agent owns: interface, executor, dependencies, license offers.
//   LICENSE the right one agent holds to use another agent's skill (per call, bundle, subscription).
//   GAS    what an agent charges to act for another. Its dollar price floats with demand (src/market/GasPrice.ts);
//          every quote, call and prepaid license locks the price it was made at.
//
// Price of one call, as a list of lines (quote() returns them; settlement pays them):
//   seller    the skill's per-call price (or its share of a prepaid bundle) + the seller agent's act fee,
//             less the royalties below
//   royalty   for each EMBEDDED dependency: the sublicensor's royaltyBps of the seller's gross
//   upstream  for each CALLED dependency: that skill's own lines, recursively (passed through to the buyer)
//   network   PayPali's fee on what the caller pays now (feeBps, minimum minFeeGas)
// The caller pays once (Score-gated, into escrow). On delivery escrow pays every line; on failure it refunds.
// The ledger moves whole cents, so each agent's sub-cent remainder carries in its AgentGasAccount.
// ---------------------------------------------------------------------------

export const SKILL_USE = 'skill.use';
export const SKILL_SELL = 'skill.sell';
export const SKILLS_SERVICE_ID = 'skills';
const SLUG = /^[a-z0-9][a-z0-9-]{2,59}$/;
const MODES = ['PER_CALL', 'BUNDLE', 'SUBSCRIPTION'] as const;
type Mode = (typeof MODES)[number];
const MAX_PRICE_GAS = 10_000_000;
const MAX_DEPTH = 4;

export type LineRole = 'seller' | 'royalty' | 'upstream' | 'network';
export interface Line { agentId: string; role: LineRole; skill: string; gas: number; prepaid?: number; prepaidMilli?: number }
export interface Dependency { skillId: string; use: 'CALL' | 'EMBED' }
export interface InvokeResult {
  status: 'SETTLED' | 'FAILED' | 'DECLINED' | 'APPROVAL_REQUIRED';
  skill: { id: string; slug: string; name: string };
  lines: Array<Line & { agentName: string | null; minorApprox: number }>;
  totalGas: number; payNowGas: number; amountMinor: bigint; priceMilli?: number;
  callId?: string; reasons?: string[]; output?: unknown; outputHash?: string; refunded?: boolean;
  settlement?: { status: string; delta: number };
}

export interface SkillContext {
  callId: string;
  callerAgentId: string;
  /** Run a CALL dependency (its Gas is in this call's quote). */
  call(slug: string, input: Record<string, unknown>): Promise<unknown>;
  /** Run an EMBEDDED (sublicensed) dependency; its owner is paid a royalty, not per call. */
  embed(slug: string, input: Record<string, unknown>): Promise<unknown>;
}
export type BuiltinSkill = (input: Record<string, unknown>, ctx: SkillContext) => Promise<unknown>;

export interface SkillMarketDeps {
  prisma: PrismaClient;
  wallet: AgentWalletService;
  dev: AgentDevService;
  gas: GasService;
  fetchFn?: DataFetch;
  /** builtin:<name> executors may be published (demo skills in the dev stack). */
  allowBuiltin?: boolean;
  allowInsecureEndpoints?: boolean;
  endpointTimeoutMs?: number;
  /** Brands that have partnered and may sell under their own name (PAYPALI_PARTNER_PROVIDERS). */
  partners?: string[];
  now?: () => Date;
}

const err = (code: string) => new Error(code);
export const signSkill = (secret: string, a: string, body: string) => 'v1=' + createHmac('sha256', secret).update(`${a}.${sha256hex(body)}`).digest('hex');
const sigEq = (a: string | null, b: string) => !!a && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class SkillMarket {
  readonly builtins = new Map<string, BuiltinSkill>();
  private system = new Map<string, string>();
  constructor(private readonly d: SkillMarketDeps) {}
  private now() { return this.d.now ? this.d.now() : new Date(); }
  registerBuiltin(name: string, fn: BuiltinSkill) { this.builtins.set(name, fn); }

  // =========================================================================
  // Seller side (owner acts)
  // =========================================================================
  async publish(ownerId: string, p: {
    agentId: string; slug: string; name: string; description?: string; category?: string; kind?: 'SKILL' | 'ACCESS';
    inputSchema?: unknown; outputSchema?: unknown; dependencies?: Array<{ skill: string; use: 'CALL' | 'EMBED' }>;
    executor: string; endpointUrl?: string; demo?: boolean;
    offers: Array<{ mode: Mode; priceGas: number; calls?: number; periodDays?: number; sublicensable?: boolean; royaltyBps?: number }>;
  }) {
    const { prisma } = this.d;
    const agent = await this.ownedAgent(ownerId, p.agentId);
    if (typeof p.slug !== 'string' || !SLUG.test(p.slug)) throw err('INVALID_SLUG');
    if (await prisma.skill.findUnique({ where: { slug: p.slug } })) throw err('SLUG_TAKEN');
    const name = String(p.name ?? '').trim();
    if (!name || name.length > 80) throw err('INVALID_NAME');
    const brand = reservedBrand(`${name} ${p.slug.replace(/-/g, ' ')} ${agent.name}`, this.d.partners);
    if (brand) throw err('BRAND_RESERVED_PENDING_PARTNERSHIP:' + brand);
    const kind = p.kind === 'ACCESS' ? 'ACCESS' : 'SKILL';
    let secret: string | null = null;
    if (p.executor === 'webhook') {
      this.checkEndpoint(p.endpointUrl);
      secret = randomBytes(32).toString('base64url');
    } else if (p.executor.startsWith('builtin:')) {
      if (!this.d.allowBuiltin) throw err('BUILTIN_SKILLS_DISABLED');
      if (!this.builtins.has(p.executor.slice(8))) throw err('UNKNOWN_BUILTIN');
    } else throw err('INVALID_EXECUTOR');
    const offers = this.checkOffers(p.offers);
    // Dependencies: the seller agent must already hold a license for each (a sublicensable one to embed it).
    const deps: Dependency[] = [];
    for (const dep of p.dependencies ?? []) {
      const s = await this.findSkill(dep.skill);
      if (dep.use !== 'CALL' && dep.use !== 'EMBED') throw err('INVALID_DEPENDENCY_USE');
      const lic = await this.activeLicense(agent.id, s.id);
      if (!lic) throw err('DEPENDENCY_NOT_LICENSED:' + s.slug);
      if (dep.use === 'EMBED' && !lic.sublicensable) throw err('DEPENDENCY_NOT_SUBLICENSABLE:' + s.slug);
      deps.push({ skillId: s.id, use: dep.use });
    }
    // Selling is an act of agency: Score account, the skill.sell capability (it appears in the Power of Agency).
    await this.d.dev.score.open(agent.id);
    await this.d.dev.skills.grantCapability(ownerId, agent.id, SKILL_SELL, 'MEDIUM' as RiskClass);
    await this.gasAccount(agent.id);
    const skill = await prisma.skill.create({
      data: {
        slug: p.slug, ownerId, agentId: agent.id, name, description: String(p.description ?? '').trim().slice(0, 1000),
        category: String(p.category ?? 'General').slice(0, 40), kind, inputSchema: (p.inputSchema ?? undefined) as Prisma.InputJsonValue,
        outputSchema: (p.outputSchema ?? undefined) as Prisma.InputJsonValue, dependencies: deps as unknown as Prisma.InputJsonValue,
        executor: p.executor, endpointUrl: p.endpointUrl ?? null, endpointSecret: secret ? sealSecret(secret) : null,
        status: secret ? 'PAUSED' : 'ACTIVE', demo: !!p.demo,
        offers: { create: offers },
      },
      include: { offers: true },
    });
    return { skill: await this.view(skill), ...(secret ? { endpointSecret: secret, next: 'Configure the secret on your endpoint, then verify it to go live.' } : {}) };
  }

  /** Owner act: the webhook proves it holds the secret (signed challenge, signed echo), then the skill goes live. */
  async verifyEndpoint(ownerId: string, skillRef: string) {
    const s = await this.findSkill(skillRef);
    if (s.ownerId !== ownerId) throw err('SKILL_NOT_OWNED');
    if (s.executor !== 'webhook') throw err('NOT_A_WEBHOOK_SKILL');
    const nonce = randomBytes(16).toString('base64url'), id = 'challenge:' + nonce;
    const r = await this.post(s, { type: 'challenge', call_id: id, challenge: nonce }, id);
    let echoed: unknown; try { echoed = JSON.parse(r.body).challenge; } catch { /* below */ }
    if (r.status !== 200 || !r.sigOk || echoed !== nonce) throw err('ENDPOINT_VERIFICATION_FAILED');
    return this.view(await this.d.prisma.skill.update({ where: { id: s.id }, data: { status: 'ACTIVE' }, include: { offers: true } }));
  }

  /** The owner sets both numbers; the agent itself may set its fee within the owner's maximum (pricing is part of agency). */
  async setRateCard(agentId: string, p: { actFeeGas?: number; maxFeeGas?: number }, by: { ownerId: string } | { agent: true }) {
    const agent = await this.d.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw err('AGENT_NOT_FOUND');
    if ('ownerId' in by && agent.ownerId !== by.ownerId) throw err('AGENT_NOT_OWNED');
    const acct = await this.gasAccount(agentId);
    const data: Prisma.AgentGasAccountUpdateInput = {};
    if (p.maxFeeGas !== undefined) {
      if (!('ownerId' in by)) throw err('ONLY_THE_OWNER_SETS_THE_MAXIMUM');
      if (!Number.isInteger(p.maxFeeGas) || p.maxFeeGas < 0 || p.maxFeeGas > MAX_PRICE_GAS) throw err('INVALID_MAX_FEE');
      data.maxFeeGas = p.maxFeeGas;
    }
    if (p.actFeeGas !== undefined) {
      const max = p.maxFeeGas ?? acct.maxFeeGas;
      if (!Number.isInteger(p.actFeeGas) || p.actFeeGas < 0) throw err('INVALID_FEE');
      if (p.actFeeGas > max) throw err('FEE_ABOVE_OWNER_MAXIMUM');
      data.actFeeGas = p.actFeeGas;
    } else if (p.maxFeeGas !== undefined && acct.actFeeGas > p.maxFeeGas) data.actFeeGas = p.maxFeeGas;
    const u = await this.d.prisma.agentGasAccount.update({ where: { agentId }, data });
    return { agentId, actFeeGas: u.actFeeGas, maxFeeGas: u.maxFeeGas };
  }

  /**
   * "Give this skill agency": an agent of its own around one skill, with its own wallet, Score and the
   * skill.sell capability, and the owner as beneficiary. The skill (and future earnings from its licenses)
   * moves to the new agent. Its Power of Agency is drafted for the owner to sign.
   */
  async elevate(ownerId: string, skillRef: string, p: { name?: string } = {}) {
    const { prisma } = this.d;
    const s = await this.findSkill(skillRef);
    if (s.ownerId !== ownerId) throw err('SKILL_NOT_OWNED');
    if (s.elevatedFromAgentId) throw err('SKILL_ALREADY_HAS_AGENCY');
    const from = await prisma.agent.findUniqueOrThrow({ where: { id: s.agentId } });
    const name = (p.name?.trim() || `${s.name} agent`).slice(0, 80);
    const agent = await prisma.agent.create({
      data: { ownerId, name, objectiveType: 'GROWTH', objectiveMandate: `Sell and improve the skill "${s.name}", and act for the agents that license it, for the benefit of my holder.`, origin: from.origin },
    });
    await this.d.wallet.ensureAccount(agent.id, 'USD');
    await this.d.dev.score.open(agent.id);
    await this.d.dev.skills.grantCapability(ownerId, agent.id, SKILL_SELL, 'MEDIUM' as RiskClass);
    const card = await this.gasAccount(from.id);
    await prisma.agentGasAccount.upsert({ where: { agentId: agent.id }, update: {}, create: { agentId: agent.id, actFeeGas: card.actFeeGas, maxFeeGas: card.maxFeeGas } });
    // Upstream licenses this skill relies on move with it, so it keeps working under its new agent.
    for (const dep of this.deps(s)) {
      const lic = await this.activeLicense(from.id, dep.skillId);
      if (lic) await prisma.license.update({ where: { id: lic.id }, data: { licenseeAgentId: agent.id } });
    }
    await prisma.license.updateMany({ where: { skillId: s.id, source: 'NATIVE' }, data: { licensorAgentId: agent.id } });
    const moved = await prisma.skill.update({ where: { id: s.id }, data: { agentId: agent.id, elevatedFromAgentId: from.id }, include: { offers: true } });
    return { agent: { id: agent.id, name: agent.name, objective: agent.objectiveMandate }, skill: await this.view(moved), next: 'Sign its Power of Agency on the dashboard so it can act and be paid.' };
  }

  // =========================================================================
  // Buyer side
  // =========================================================================
  /** What one call costs this caller, line by line, and anything that would block it. */
  async quote(callerAgentId: string, skillRef: string, p: { licenseId?: string; offerId?: string } = {}, out?: { released: Array<{ licenseId: string; gas: number }> }) {
    const s = await this.findSkill(skillRef);
    const lic = p.licenseId ? await this.d.prisma.license.findUnique({ where: { id: p.licenseId } }) : await this.activeLicense(callerAgentId, s.id);
    const blockers: string[] = [];
    let offer: SkillOffer | null = null;
    if (lic) { if (lic.licenseeAgentId !== callerAgentId || lic.skillId !== s.id) throw err('LICENSE_NOT_FOUND'); offer = lic.offerId ? await this.d.prisma.skillOffer.findUnique({ where: { id: lic.offerId } }) : null; }
    else {
      offer = p.offerId ? await this.d.prisma.skillOffer.findUnique({ where: { id: p.offerId } }) : (await this.offers(s.id)).find((o) => o.mode === 'PER_CALL') ?? null;
      blockers.push('NOT_LICENSED');
    }
    if (s.status !== 'ACTIVE') blockers.push('SKILL_NOT_LIVE');
    const priced = await this.price(s, lic, offer, 0, blockers);
    if (out) out.released = priced.released;
    const priceMilli = this.d.gas.priceMilli;                       // the Gas price this quote is made at
    const chargeNow = priced.lines.reduce((a, l) => a + l.gas - (l.prepaid ?? 0), 0);
    const network = chargeNow > 0 ? Math.max(this.d.gas.cfg.minFeeGas, Math.ceil((chargeNow * this.d.gas.cfg.feeBps) / 10_000)) : 0;
    const lines: Line[] = [...priced.lines, ...(network ? [{ agentId: await this.systemAgent('network'), role: 'network' as const, skill: s.slug, gas: network }] : [])];
    const payNowGas = chargeNow + network;
    return {
      skill: { id: s.id, slug: s.slug, name: s.name }, licenseId: lic?.id ?? null, offer: offer ? this.offerView(offer) : null,
      lines: await this.named(lines, priceMilli), totalGas: lines.reduce((a, l) => a + l.gas, 0), payNowGas, amountMinor: payNowGas ? this.d.gas.gasToMinorAt(payNowGas, priceMilli) : 0n,
      priceMilli, usdPerGas: priceMilli / 100_000, currency: 'USD', blockers: [...new Set(blockers)],
    };
  }

  /** License a skill for an agent. Per-call licenses are free to hold; bundles and subscriptions are paid up front into escrow. */
  async license(callerAgentId: string, p: { skill: string; offerId?: string }, by: { ownerId: string } | { connection: AgentConnection }) {
    const { prisma } = this.d;
    const agent = await prisma.agent.findUnique({ where: { id: callerAgentId } });
    if (!agent) throw err('AGENT_NOT_FOUND');
    if ('ownerId' in by && agent.ownerId !== by.ownerId) throw err('AGENT_NOT_OWNED');
    if (!agent.isActive) throw err('AGENT_INACTIVE');
    const s = await this.findSkill(p.skill);
    if (s.status !== 'ACTIVE') throw err('SKILL_NOT_LIVE');
    if (s.agentId === callerAgentId) throw err('CANNOT_LICENSE_OWN_SKILL');
    const offers = await this.offers(s.id);
    const offer = p.offerId ? offers.find((o) => o.id === p.offerId) : offers.find((o) => o.mode === 'PER_CALL') ?? offers[0];
    if (!offer || !offer.active) throw err('OFFER_NOT_FOUND');
    const existing = await this.activeLicense(callerAgentId, s.id);
    if (existing && existing.offerId === offer.id && offer.mode === 'PER_CALL') return { license: await this.licenseView(existing), replayed: true };

    // Using skills is a capability. The owner licensing for their agent grants it; a connection needs it already.
    if ('ownerId' in by) { await this.d.dev.score.open(callerAgentId); await this.d.dev.skills.grantCapability(by.ownerId, callerAgentId, SKILL_USE, 'MEDIUM' as RiskClass); }
    await this.gasAccount(callerAgentId);
    const upfront = offer.mode === 'PER_CALL' ? 0 : offer.priceGas;
    const network = upfront > 0 ? Math.max(this.d.gas.cfg.minFeeGas, Math.ceil((upfront * this.d.gas.cfg.feeBps) / 10_000)) : 0;
    const priceMilli = this.d.gas.priceMilli;                       // prepaid Gas is bought at today's price
    const amountMinor = upfront ? this.d.gas.gasToMinorAt(upfront + network, priceMilli) : 0n;
    if (upfront) {
      const q = await this.d.dev.score.quote({ agentId: callerAgentId, capability: SKILL_USE, intentKey: `skill-license:${s.slug}:${randomUUID()}`, confidencePct: 80, amountMinor, currency: 'USD' });
      const blocking = q.reasons.filter((r) => r !== 'INSUFFICIENT_SCORE');
      if (blocking.length) throw err(blocking[0]);
      if ('connection' in by) {
        const problems = await this.d.gas.mandateProblems(prisma, by.connection, SKILLS_SERVICE_ID, amountMinor, { recurring: offer.mode === 'SUBSCRIPTION' });
        if (problems.length) throw err(problems[0]);
      }
    }
    if (existing) await this.revokeRow(existing);                    // one live license per skill: a new offer replaces the old one
    const id = randomUUID();
    if (upfront) {
      await this.d.wallet.send({ fromAgentId: callerAgentId, toAgentId: await this.systemAgent('escrow'), amountMinor, currency: 'USD', idempotencyKey: `skill-license:${id}` });
      await this.credit(await this.systemAgent('network'), network, `skill-license-fee:${id}`, await this.systemAgent('escrow'), priceMilli);
      await prisma.agentGasAccount.update({ where: { agentId: callerAgentId }, data: { spentGas: { increment: upfront + network } } });
    }
    const lic = await prisma.license.create({
      data: {
        id, source: 'NATIVE', sourceRef: id, skillId: s.id, skillRef: 'skill:' + s.slug, skillName: s.name, offerId: offer.id,
        licensorAgentId: s.agentId, licenseeAgentId: callerAgentId, licenseeOwnerId: agent.ownerId, mode: offer.mode,
        priceGas: offer.priceGas, callsTotal: offer.mode === 'PER_CALL' ? null : offer.calls ?? null, prepaidGas: upfront, gasPriceMilli: priceMilli,
        sublicensable: offer.sublicensable, royaltyBps: offer.royaltyBps,
        expiresAt: offer.periodDays ? new Date(this.now().getTime() + offer.periodDays * 86_400_000) : null,
      },
    });
    return { license: await this.licenseView(lic), paidGas: upfront + network, amountMinor, replayed: false };
  }

  /** Owner act: revoke a license the owner's agent holds. Unused prepaid Gas goes back to the agent. */
  async revoke(ownerId: string, licenseId: string) {
    const lic = await this.d.prisma.license.findUnique({ where: { id: licenseId } });
    if (!lic || lic.licenseeOwnerId !== ownerId) throw err('LICENSE_NOT_FOUND');
    if (lic.source !== 'NATIVE') throw err('REVOKE_AT_ITS_SOURCE');
    await this.revokeRow(lic);
    return this.licenseView((await this.d.prisma.license.findUnique({ where: { id: licenseId } }))!);
  }

  /** One call: Score gate → one payment into escrow → run → pay every line, or refund. */
  async invoke(callerAgentId: string, p: { skill: string; input?: Record<string, unknown>; confidencePct: number; licenseId?: string; intentKey?: string; maxAmountMinor?: bigint }, connection?: AgentConnection | null): Promise<InvokeResult> {
    const { prisma } = this.d;
    const out = { released: [] as Array<{ licenseId: string; gas: number }> };
    const q = await this.quote(callerAgentId, p.skill, { licenseId: p.licenseId }, out);
    const released = out.released;
    const s = await this.findSkill(p.skill);
    const lic = q.licenseId ? await prisma.license.findUniqueOrThrow({ where: { id: q.licenseId } }) : null;
    const base = { skill: q.skill, lines: q.lines, totalGas: q.totalGas, payNowGas: q.payNowGas, amountMinor: q.amountMinor, priceMilli: q.priceMilli };
    const blockers = [...q.blockers];
    // Gas floats: the caller may cap what it pays in dollars, whatever the Gas price is when the call runs.
    if (p.maxAmountMinor != null && q.amountMinor > p.maxAmountMinor) blockers.push('PRICE_ABOVE_YOUR_MAXIMUM');
    if (lic) blockers.push(...this.licenseProblems(lic));
    const seller = await prisma.agent.findUnique({ where: { id: s.agentId } });
    if (!seller?.isActive) blockers.push('SELLER_AGENT_STOPPED');
    const input = (p.input ?? {}) as Record<string, unknown>;
    blockers.push(...this.inputProblems(s, input));
    if (blockers.length) return { ...base, status: 'DECLINED' as const, reasons: [...new Set(blockers)] };
    if (connection) {
      const problems = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "AgentConnection" WHERE id = ${connection.id} FOR UPDATE`;
        const fresh = await tx.agentConnection.findUniqueOrThrow({ where: { id: connection.id } });
        return this.d.gas.mandateProblems(tx, fresh, SKILLS_SERVICE_ID, q.amountMinor);
      });
      if (problems.length) return { ...base, status: problems.includes('APPROVAL_REQUIRED') ? 'APPROVAL_REQUIRED' as const : 'DECLINED' as const, reasons: problems };
    }
    const callId = randomUUID();
    const rawLines = q.lines.map(({ agentId, role, skill, gas, prepaid, prepaidMilli }) => ({ agentId, role, skill, gas, ...(prepaid ? { prepaid, prepaidMilli } : {}) }));
    await prisma.skillCall.create({
      data: { id: callId, licenseId: lic!.id, skillId: s.id, callerAgentId, connectionId: connection?.id ?? null, totalGas: q.totalGas, amountMinor: q.amountMinor, gasPriceMilli: q.priceMilli, lines: rawLines },
    });
    // Score gate on the caller: its honest probability that this call does what it needs.
    let stakeId: string;
    try {
      const c = await this.d.dev.score.commit({ agentId: callerAgentId, capability: SKILL_USE, intentKey: p.intentKey?.trim() || `skill:${s.slug}:${callId}`, confidencePct: p.confidencePct, amountMinor: q.amountMinor, currency: 'USD' });
      stakeId = c.stakeId;
    } catch (e) {
      const sq = (e as { quote?: { reasons: string[] } }).quote;
      const reasons = sq ? sq.reasons : [(e as Error).message];
      await prisma.skillCall.update({ where: { id: callId }, data: { status: 'DECLINED', reason: reasons.join(',') } });
      return { ...base, callId, status: 'DECLINED' as const, reasons };
    }
    const escrow = await this.systemAgent('escrow');
    if (q.amountMinor > 0n) {
      try { await this.d.wallet.send({ fromAgentId: callerAgentId, toAgentId: escrow, amountMinor: q.amountMinor, currency: 'USD', idempotencyKey: `skill-call:${callId}` }); }
      catch (e) {
        await prisma.skillCall.update({ where: { id: callId }, data: { status: 'FAILED', reason: (e as Error).message, stakeId } });
        await this.d.dev.score.settle(stakeId, { success: false, evidence: { callId, reason: (e as Error).message } });
        return { ...base, callId, status: 'FAILED' as const, reasons: [(e as Error).message] };
      }
    }
    const used: string[] = [lic!.id];
    let output: unknown;
    try { output = await this.execute(s, input, { callId, callerAgentId, sellerAgentId: s.agentId, used, depth: 0 }); }
    catch (e) {
      const reason = (e as Error).message;
      if (q.amountMinor > 0n) await this.d.wallet.send({ fromAgentId: escrow, toAgentId: callerAgentId, amountMinor: q.amountMinor, currency: 'USD', idempotencyKey: `skill-refund:${callId}` });
      await prisma.skillCall.update({ where: { id: callId }, data: { status: 'FAILED', reason: reason.slice(0, 300), stakeId } });
      const settlement = await this.d.dev.score.settle(stakeId, { success: false, evidence: { callId, reason } });
      return { ...base, callId, status: 'FAILED' as const, reasons: [reason], refunded: true, settlement };
    }
    // Delivered: pay every line out of escrow (prepaid shares come out of the licenses' escrowed Gas).
    // What the caller paid now is credited at this call's Gas price; prepaid shares at the price they were bought at.
    for (const [i, l] of rawLines.entries()) {
      const pre = l.prepaid ?? 0;
      await this.credit(l.agentId, l.gas - pre, `skill-pay:${callId}:${i}`, escrow, q.priceMilli);
      if (pre) await this.credit(l.agentId, pre, `skill-pay-prepaid:${callId}:${i}`, escrow, l.prepaidMilli ?? q.priceMilli);
    }
    for (const r of released) await prisma.license.update({ where: { id: r.licenseId }, data: { prepaidGas: { decrement: r.gas } } });
    for (const id of used) {
      const u = await prisma.license.update({ where: { id }, data: { callsUsed: { increment: 1 } } });
      if (u.callsTotal != null && u.callsUsed >= u.callsTotal) await prisma.license.update({ where: { id }, data: { status: 'EXHAUSTED' } });
    }
    await prisma.agentGasAccount.update({ where: { agentId: callerAgentId }, data: { spentGas: { increment: q.payNowGas } } });
    const outputHash = sha256hex(JSON.stringify(output ?? null));
    await prisma.skillCall.update({ where: { id: callId }, data: { status: 'SETTLED', outputHash, stakeId, settledAt: this.now() } });
    const settlement = await this.d.dev.score.settle(stakeId, { success: true, evidence: { callId, outputHash } });
    return { ...base, callId, status: 'SETTLED' as const, output, outputHash, settlement };
  }

  // =========================================================================
  // Views
  // =========================================================================
  async list(q: { query?: string; category?: string; agentId?: string; kind?: string } = {}) {
    const rows = await this.d.prisma.skill.findMany({
      where: { status: { in: ['ACTIVE', 'PAUSED'] }, ...(q.agentId ? { agentId: q.agentId } : {}), ...(q.kind ? { kind: q.kind } : {}), ...(q.category ? { category: q.category } : {}) },
      include: { offers: true }, orderBy: { createdAt: 'asc' },
    });
    const needle = q.query?.toLowerCase().trim();
    const hit = needle ? rows.filter((s) => (s.name + ' ' + s.description + ' ' + s.category + ' ' + s.slug).toLowerCase().includes(needle)) : rows;
    return Promise.all(hit.map((s) => this.view(s)));
  }

  async get(skillRef: string) {
    const s = await this.findSkill(skillRef);
    return this.view(await this.d.prisma.skill.findUniqueOrThrow({ where: { id: s.id }, include: { offers: true } }));
  }

  /** Licenses the agent holds: native ones plus Bazaar receipts, data subscriptions and spending grants. */
  async holdings(agentId: string) {
    await this.syncExternal(agentId);
    const rows = await this.d.prisma.license.findMany({ where: { licenseeAgentId: agentId }, orderBy: { createdAt: 'desc' }, take: 200 });
    return Promise.all(rows.map((l) => this.licenseView(l)));
  }

  /** Per agent: what it holds, sells, earns and spends. */
  async economy(agentId: string, extra: { bazaarListings?: Array<{ id: string; name: string; priceMinor: number; sellerAgentId?: string | null }> } = {}) {
    const p = this.d.prisma;
    const agent = await p.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw err('AGENT_NOT_FOUND');
    const [holds, skills, card, calls, payouts, batches, services, bazaarOrders, dataQueries, dataAgent, sold] = await Promise.all([
      this.holdings(agentId),
      p.skill.findMany({ where: { agentId }, include: { offers: true } }),
      this.gasAccount(agentId),
      p.skillCall.findMany({ where: { status: 'SETTLED' }, orderBy: { createdAt: 'desc' }, take: 5000 }),
      p.merchantPayout.findMany({ where: { toAgentId: agentId } }),
      p.dataSettlementBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 500 }),
      p.serviceOrder.findMany({ where: { agentId, status: { in: ['FULFILLED', 'PENDING_PROVIDER'] } } }),
      p.bazaarOrder.findMany({ where: { agentId, status: 'PAID' } }),
      p.dataQuery.findMany({ where: { buyerAgentId: agentId, status: { in: ['ANSWERED', 'SETTLED'] } } }),
      p.dataAgent.findFirst({ where: { agentId }, include: { questionTypes: true } }),
      p.license.findMany({ where: { licensorAgentId: agentId, source: 'NATIVE' } }),
    ]);
    const g2m = (g: number) => Number(this.d.gas.gasToMinor(g));
    const earnByRole: Record<string, number> = { seller: 0, royalty: 0, upstream: 0 };
    const recent: Array<{ at: Date; kind: string; what: string; gas?: number; minor: number }> = [];
    let spentSkillGas = 0, spentSkillMinor = 0, earnMilliMinor = 0;
    const skillNames = new Map((await p.skill.findMany({ select: { id: true, slug: true, name: true } })).map((s) => [s.slug, s.name]));
    for (const c of calls) {
      const lines = (c.lines as unknown as Line[]) ?? [];
      for (const l of lines) {
        if (l.agentId !== agentId || l.role === 'network') continue;
        earnByRole[l.role] = (earnByRole[l.role] ?? 0) + l.gas;
        const m = ((l.gas - (l.prepaid ?? 0)) * c.gasPriceMilli + (l.prepaid ?? 0) * (l.prepaidMilli ?? c.gasPriceMilli)) / 1000;
        earnMilliMinor += m * 1000;
        if (recent.length < 40) recent.push({ at: c.createdAt, kind: 'earned', what: `${l.role === 'royalty' ? 'Royalty on' : l.role === 'upstream' ? 'Access sold through' : 'Sold a call of'} ${skillNames.get(l.skill) ?? l.skill}`, gas: l.gas, minor: Math.floor(m) });
      }
      if (c.callerAgentId === agentId) { spentSkillGas += Math.max(0, c.totalGas - lines.reduce((a, l) => a + (l.prepaid ?? 0), 0)); spentSkillMinor += Number(c.amountMinor); }
    }
    const prepaidRows = await p.license.findMany({ where: { licenseeAgentId: agentId, source: 'NATIVE', mode: { in: ['BUNDLE', 'SUBSCRIPTION'] } } });
    const licensePrepaid = prepaidRows.reduce((a, h) => a + h.priceGas, 0);
    const licensePrepaidMinor = prepaidRows.reduce((a, h) => a + Math.ceil((h.priceGas * h.gasPriceMilli) / 1000), 0);
    const bazaarEarnMinor = payouts.reduce((a, x) => a + Number(x.amountMinor), 0);
    let dataEarnMinor = 0;
    for (const b of batches) for (const x of ((b.payouts as any[]) ?? [])) if (x.agentId === agentId) dataEarnMinor += Number(x.minor ?? 0);
    const servicesMinor = services.reduce((a, x) => a + Number(x.amountMinor), 0);
    const bazaarMinor = bazaarOrders.reduce((a, x) => a + Number(x.amountMinor), 0);
    const dataMinor = dataQueries.reduce((a, x) => a + Number(x.amountMinor), 0);
    const skillEarnGas = earnByRole.seller + earnByRole.royalty + earnByRole.upstream;
    for (const x of payouts.slice(-10)) recent.push({ at: x.createdAt, kind: 'earned', what: 'AgentBazaar sale (payout)', minor: Number(x.amountMinor) });
    recent.sort((a, b) => +b.at - +a.at);
    const balance = await this.d.wallet.getBalance(agentId, 'USD').catch(() => 0n);
    const bazaarSells = (extra.bazaarListings ?? []).filter((l) => l.sellerAgentId === agentId);
    return {
      agent: { id: agent.id, name: agent.name, isActive: agent.isActive },
      wallet: { currency: 'USD', availableMinor: balance },
      rateCard: { actFeeGas: card.actFeeGas, maxFeeGas: card.maxFeeGas },
      gas: { priceMilliMinor: this.d.gas.priceMilli, feeBps: this.d.gas.cfg.feeBps, minFeeGas: this.d.gas.cfg.minFeeGas },
      holds,
      sells: {
        skills: await Promise.all(skills.map(async (s) => ({ ...(await this.view(s)), licensees: sold.filter((l) => l.skillId === s.id && l.status === 'ACTIVE').length }))),
        bazaarListings: bazaarSells,
        dataAgent: dataAgent ? { slug: dataAgent.slug, name: dataAgent.name, status: dataAgent.status, questionTypes: dataAgent.questionTypes.filter((q) => q.active).map((q) => ({ key: q.key, title: q.title })) } : null,
      },
      earns: {
        totalMinor: Math.floor(earnMilliMinor / 1000) + bazaarEarnMinor + dataEarnMinor,
        skillsGas: skillEarnGas, byRole: earnByRole, skillsMinor: Math.floor(earnMilliMinor / 1000), bazaarMinor: bazaarEarnMinor, dataMinor: dataEarnMinor,
        recent: recent.filter((r) => r.kind === 'earned').slice(0, 15),
      },
      spends: {
        totalMinor: spentSkillMinor + licensePrepaidMinor + servicesMinor + bazaarMinor + dataMinor,
        skillsGas: spentSkillGas + licensePrepaid, skillsMinor: spentSkillMinor + licensePrepaidMinor, servicesMinor, bazaarMinor, dataMinor,
      },
    };
  }

  /** Mirror Bazaar receipts, data subscriptions and spending grants into License rows (idempotent). */
  async syncExternal(agentId: string) {
    const p = this.d.prisma;
    const agent = await p.agent.findUnique({ where: { id: agentId } });
    if (!agent) return;
    const up = (source: string, sourceRef: string, data: Omit<Prisma.LicenseUncheckedCreateInput, 'source' | 'sourceRef'>, update: Prisma.LicenseUncheckedUpdateInput) =>
      p.license.upsert({ where: { source_sourceRef: { source, sourceRef } }, create: { source, sourceRef, ...data }, update });
    const base = { licenseeAgentId: agentId, licenseeOwnerId: agent.ownerId };
    for (const o of await p.bazaarOrder.findMany({ where: { agentId, status: 'PAID', receiptId: { not: null } } })) {
      const body = ((o.receipt as any)?.body ?? {}) as Record<string, any>;
      const runs = Number(body.runs_included) || null;
      await up('BAZAAR', o.receiptId!, { ...base, skillRef: 'bazaar:' + o.solutionId, skillName: String(body.solution_name ?? body.name ?? o.solutionId), mode: 'BUNDLE', callsTotal: runs, priceGas: this.d.gas.minorToGas(Number(o.amountMinor)), licensorAgentId: body.seller_agent_id ?? null }, {});
    }
    const subs = await p.dataSubscription.findMany({ where: { buyerAgentId: agentId } });
    const das = subs.length ? await p.dataAgent.findMany({ where: { id: { in: subs.map((s) => s.dataAgentId) } } }) : [];
    for (const s of subs) {
      const da = das.find((x) => x.id === s.dataAgentId);
      const status = s.status === 'ACTIVE' ? 'ACTIVE' : 'REVOKED';
      await up('DATA_SUBSCRIPTION', s.id, { ...base, skillRef: 'data:' + (da?.slug ?? s.dataAgentId), skillName: da?.name ?? 'Data agent', mode: 'SUBSCRIPTION', licensorAgentId: da?.agentId ?? null, capMinor: s.monthlyBudgetMinor, status }, { status, capMinor: s.monthlyBudgetMinor });
    }
    for (const g of await p.merchantGrant.findMany({ where: { agentId } })) {
      const live = g.status === 'ACTIVE' && (!g.expiresAt || g.expiresAt > this.now());
      const status = live ? (g.usedMinor >= g.maxMinor ? 'EXHAUSTED' : 'ACTIVE') : g.status === 'REVOKED' ? 'REVOKED' : 'EXPIRED';
      await up('MERCHANT_GRANT', g.id, { ...base, skillRef: 'merchant:' + g.merchantId, skillName: g.merchantId === 'agentbazaar' ? 'AgentBazaar purchases' : `Purchases at ${g.merchantId}`, mode: 'SPENDING_CAP', capMinor: g.maxMinor, usedMinor: g.usedMinor, expiresAt: g.expiresAt, status }, { status, usedMinor: g.usedMinor });
    }
  }

  // =========================================================================
  // Pricing and execution
  // =========================================================================
  /**
   * Lines for one call of `s` under license `lic` (or an offer, for a preview). Prepaid shares of bundles and
   * subscriptions are released from escrow (`released`), so they are in the lines but not in what the caller pays now.
   */
  private async price(s: Skill, lic: License | null, offer: SkillOffer | null, depth: number, blockers: string[]): Promise<{ lines: Line[]; released: Array<{ licenseId: string; gas: number }> }> {
    if (depth > MAX_DEPTH) { blockers.push('DEPENDENCY_CHAIN_TOO_DEEP'); return { lines: [], released: [] }; }
    const card = await this.gasAccount(s.agentId);
    let priceNow = 0, prepaid = 0;
    if (lic && lic.mode !== 'PER_CALL') {
      const remaining = lic.mode === 'BUNDLE' && lic.callsTotal ? Math.max(1, lic.callsTotal - lic.callsUsed) : 1;
      prepaid = lic.mode === 'SUBSCRIPTION' && lic.callsUsed > 0 ? 0 : Math.floor(lic.prepaidGas / remaining);
    } else if (lic) priceNow = lic.priceGas;
    else if (offer?.mode === 'PER_CALL') priceNow = offer.priceGas;
    else if (offer?.mode === 'BUNDLE') prepaid = Math.floor(offer.priceGas / (offer.calls || 1));   // preview only
    const gross = priceNow + prepaid + card.actFeeGas;
    const royalties: Line[] = [], upstream: Line[] = [], released: Array<{ licenseId: string; gas: number }> = [];
    if (lic && prepaid) released.push({ licenseId: lic.id, gas: prepaid });
    for (const dep of this.deps(s)) {
      const ds = await this.d.prisma.skill.findUnique({ where: { id: dep.skillId } });
      if (!ds) { blockers.push('DEPENDENCY_MISSING'); continue; }
      const dl = await this.activeLicense(s.agentId, ds.id);
      if (!dl) { blockers.push('DEPENDENCY_NOT_LICENSED:' + ds.slug); continue; }
      if (dep.use === 'EMBED') {
        const r = Math.floor((gross * dl.royaltyBps) / 10_000);
        if (r > 0) royalties.push({ agentId: ds.agentId, role: 'royalty', skill: ds.slug, gas: r });
      } else {
        const dOffer = dl.offerId ? await this.d.prisma.skillOffer.findUnique({ where: { id: dl.offerId } }) : null;
        const sub = await this.price(ds, dl, dOffer, depth + 1, blockers);
        for (const l of sub.lines) upstream.push({ ...l, role: l.role === 'seller' ? 'upstream' : l.role });
        released.push(...sub.released);
      }
    }
    const royaltyTotal = royalties.reduce((a, l) => a + l.gas, 0);
    const own: Line[] = [{ agentId: s.agentId, role: 'seller', skill: s.slug, gas: gross - royaltyTotal }, ...royalties];
    // This level's prepaid share covers the seller line first, then its royalties.
    let left = prepaid;
    for (const l of own) { const take = Math.min(left, l.gas); if (take > 0) { l.prepaid = take; l.prepaidMilli = lic?.gasPriceMilli; left -= take; } }
    return { lines: [...own, ...upstream], released };
  }

  private async execute(s: Skill, input: Record<string, unknown>, c: { callId: string; callerAgentId: string; sellerAgentId: string; used: string[]; depth: number }): Promise<unknown> {
    if (c.depth > MAX_DEPTH) throw err('DEPENDENCY_CHAIN_TOO_DEEP');
    const deps = this.deps(s);
    const run = async (slug: string, use: 'CALL' | 'EMBED', inp: Record<string, unknown>) => {
      const ds = await this.findSkill(slug);
      if (!deps.some((d) => d.skillId === ds.id && d.use === use)) throw err(`UNDECLARED_DEPENDENCY:${slug}`);
      const dl = await this.activeLicense(s.agentId, ds.id);
      if (!dl) throw err('DEPENDENCY_NOT_LICENSED:' + slug);
      if (use === 'CALL') c.used.push(dl.id);
      return this.execute(ds, inp, { ...c, sellerAgentId: ds.agentId, depth: c.depth + 1 });
    };
    const ctx: SkillContext = { callId: c.callId, callerAgentId: c.callerAgentId, call: (slug, i) => run(slug, 'CALL', i), embed: (slug, i) => run(slug, 'EMBED', i) };
    if (s.executor.startsWith('builtin:')) {
      const fn = this.builtins.get(s.executor.slice(8));
      if (!fn) throw err('BUILTIN_UNAVAILABLE');
      return fn(input, ctx);
    }
    const r = await this.post(s, { type: 'skill.invoke', call_id: c.callId, skill: s.slug, input, caller: { agent_id: c.callerAgentId } }, c.callId);
    if (r.status !== 200) throw err('PROVIDER_ERROR_' + r.status);
    if (!r.sigOk) throw err('PROVIDER_SIGNATURE_INVALID');
    let j: any; try { j = JSON.parse(r.body); } catch { throw err('PROVIDER_ANSWER_NOT_JSON'); }
    if (!j || typeof j !== 'object' || !('output' in j)) throw err('PROVIDER_ANSWER_HAS_NO_OUTPUT');
    return j.output;
  }

  private async post(s: Skill, payload: Record<string, unknown>, callId: string) {
    if (!this.d.fetchFn || !s.endpointUrl || !s.endpointSecret) throw err('ENDPOINT_NOT_CONFIGURED');
    const secret = openSecret(s.endpointSecret), body = JSON.stringify(payload), ts = String(this.now().getTime());
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), this.d.endpointTimeoutMs ?? 10_000);
    try {
      const r = await this.d.fetchFn(s.endpointUrl, {
        method: 'POST', signal: ctl.signal, body,
        headers: { 'content-type': 'application/json', 'x-paypali-skill-ts': ts, 'x-paypali-skill-signature': signSkill(secret, ts, body), 'user-agent': 'PayPali-Skills/1' },
      });
      const text = await r.text();
      if (Buffer.byteLength(text) > 256 * 1024) throw err('ANSWER_TOO_LARGE');
      return { status: r.status, body: text, sigOk: sigEq(r.headers.get('x-skill-signature'), signSkill(secret, callId, text)) };
    } finally { clearTimeout(timer); }
  }

  // =========================================================================
  // Money: whole cents on the ledger, sub-cent carry per agent
  // =========================================================================
  private async credit(agentId: string, gas: number, key: string, fromAgentId: string, priceMilli: number) {
    if (gas <= 0) return;
    await this.gasAccount(agentId);
    const cents = await this.d.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "agentId" FROM "AgentGasAccount" WHERE "agentId" = ${agentId} FOR UPDATE`;
      const a = await tx.agentGasAccount.findUniqueOrThrow({ where: { agentId } });
      const milli = a.carryMilli + gas * priceMilli;
      await tx.agentGasAccount.update({ where: { agentId }, data: { carryMilli: milli % 1000, earnedGas: { increment: gas } } });
      return Math.floor(milli / 1000);
    });
    if (cents > 0 && fromAgentId !== agentId) await this.d.wallet.send({ fromAgentId, toAgentId: agentId, amountMinor: BigInt(cents), currency: 'USD', idempotencyKey: key });
  }

  private async revokeRow(l: License) {
    await this.d.prisma.license.update({ where: { id: l.id }, data: { status: 'REVOKED' } });
    if (l.prepaidGas > 0) {
      const minor = BigInt(Math.floor((l.prepaidGas * l.gasPriceMilli) / 1000));
      if (minor > 0n) await this.d.wallet.send({ fromAgentId: await this.systemAgent('escrow'), toAgentId: l.licenseeAgentId, amountMinor: minor, currency: 'USD', idempotencyKey: `skill-license-refund:${l.id}` });
      await this.d.prisma.license.update({ where: { id: l.id }, data: { prepaidGas: 0 } });
    }
  }

  async systemAgent(kind: 'escrow' | 'network'): Promise<string> {
    const cached = this.system.get(kind);
    if (cached) return cached;
    const email = `skills+${kind}@paypali.system`;
    const owner = await this.d.prisma.owner.upsert({ where: { email }, update: {}, create: { email } });
    const name = kind === 'escrow' ? 'Skill escrow' : 'PayPali network fees';
    const a = (await this.d.prisma.agent.findFirst({ where: { ownerId: owner.id, name } })) ?? (await this.d.prisma.agent.create({ data: { ownerId: owner.id, name } }));
    await this.d.wallet.ensureAccount(a.id, 'USD');
    this.system.set(kind, a.id);
    return a.id;
  }

  // =========================================================================
  // Helpers
  // =========================================================================
  async gasAccount(agentId: string) {
    return this.d.prisma.agentGasAccount.upsert({ where: { agentId }, update: {}, create: { agentId } });
  }

  async findSkill(ref: string): Promise<Skill> {
    const key = String(ref ?? '').replace(/^skill:/, '');
    const s = (await this.d.prisma.skill.findUnique({ where: { slug: key } })) ?? (/^[0-9a-f-]{36}$/.test(key) ? await this.d.prisma.skill.findUnique({ where: { id: key } }) : null);
    if (!s) throw err('SKILL_NOT_FOUND');
    return s;
  }

  private async activeLicense(agentId: string, skillId: string) {
    const ls = await this.d.prisma.license.findMany({ where: { licenseeAgentId: agentId, skillId, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' } });
    return ls.find((l) => this.licenseProblems(l).length === 0) ?? null;
  }

  private licenseProblems(l: License): string[] {
    if (l.status !== 'ACTIVE') return ['LICENSE_' + l.status];
    if (l.expiresAt && l.expiresAt <= this.now()) return ['LICENSE_EXPIRED'];
    if (l.callsTotal != null && l.callsUsed >= l.callsTotal) return ['LICENSE_EXHAUSTED'];
    return [];
  }

  private inputProblems(s: Skill, input: Record<string, unknown>): string[] {
    const req = ((s.inputSchema as any)?.required ?? []) as string[];
    return req.filter((k) => input[k] === undefined || input[k] === '').map((k) => 'INPUT_REQUIRED:' + k);
  }

  private deps(s: Skill): Dependency[] { return Array.isArray(s.dependencies) ? (s.dependencies as unknown as Dependency[]) : []; }
  private offers(skillId: string) { return this.d.prisma.skillOffer.findMany({ where: { skillId, active: true }, orderBy: { priceGas: 'asc' } }); }

  private checkOffers(offers: Array<{ mode: Mode; priceGas: number; calls?: number; periodDays?: number; sublicensable?: boolean; royaltyBps?: number }>) {
    if (!Array.isArray(offers) || !offers.length || offers.length > 6) throw err('OFFERS_REQUIRED');
    return offers.map((o) => {
      if (!MODES.includes(o.mode)) throw err('INVALID_OFFER_MODE');
      if (!Number.isInteger(o.priceGas) || o.priceGas < 0 || o.priceGas > MAX_PRICE_GAS) throw err('INVALID_PRICE');
      if (o.mode === 'BUNDLE' && !(Number.isInteger(o.calls) && o.calls! >= 1 && o.calls! <= 100_000)) throw err('BUNDLE_NEEDS_CALLS');
      if (o.mode === 'SUBSCRIPTION' && !(Number.isInteger(o.periodDays) && o.periodDays! >= 1 && o.periodDays! <= 366)) throw err('SUBSCRIPTION_NEEDS_PERIOD');
      const royaltyBps = o.royaltyBps ?? 0;
      if (!(Number.isInteger(royaltyBps) && royaltyBps >= 0 && royaltyBps <= 5000)) throw err('INVALID_ROYALTY');
      if (royaltyBps && !o.sublicensable) throw err('ROYALTY_NEEDS_SUBLICENSABLE');
      // Sublicensing is off unless the seller allows it AND sets the royalty it is paid on every downstream call.
      if (o.sublicensable && royaltyBps <= 0) throw err('SUBLICENSE_NEEDS_ROYALTY');
      return { mode: o.mode, priceGas: o.priceGas, calls: o.calls ?? null, periodDays: o.periodDays ?? (o.mode === 'BUNDLE' ? 90 : null), sublicensable: !!o.sublicensable, royaltyBps };
    });
  }

  private checkEndpoint(url: unknown) {
    let u: URL; try { u = new URL(String(url)); } catch { throw err('INVALID_ENDPOINT'); }
    if (u.protocol !== 'https:' && !(this.d.allowInsecureEndpoints && u.protocol === 'http:')) throw err('ENDPOINT_MUST_BE_HTTPS');
  }

  private async ownedAgent(ownerId: string, agentId: string) {
    const a = await this.d.prisma.agent.findUnique({ where: { id: agentId } });
    if (!a || a.ownerId !== ownerId) throw err('AGENT_NOT_OWNED');
    if (!a.isActive) throw err('AGENT_INACTIVE');
    return a;
  }

  private async named(lines: Line[], priceMilli = this.d.gas.priceMilli) {
    const ids = [...new Set(lines.map((l) => l.agentId))];
    const agents = await this.d.prisma.agent.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return lines.map((l) => ({ ...l, agentName: agents.find((a) => a.id === l.agentId)?.name ?? null, minorApprox: Number(this.d.gas.gasToMinorAt(l.gas, priceMilli)) }));
  }

  offerView(o: SkillOffer) {
    return { id: o.id, mode: o.mode, priceGas: o.priceGas, priceMinorApprox: Number(this.d.gas.gasToMinor(o.priceGas)), calls: o.calls, periodDays: o.periodDays, sublicensable: o.sublicensable, royaltyBps: o.royaltyBps };
  }

  async view(s: Skill & { offers?: SkillOffer[] }) {
    const p = this.d.prisma;
    const [agent, card, deps, served, licensees] = await Promise.all([
      p.agent.findUnique({ where: { id: s.agentId }, select: { id: true, name: true, isActive: true } }),
      this.gasAccount(s.agentId),
      Promise.all(this.deps(s).map(async (d) => { const x = await p.skill.findUnique({ where: { id: d.skillId } }); return x ? { slug: x.slug, name: x.name, use: d.use, agentId: x.agentId } : null; })),
      p.skillCall.count({ where: { skillId: s.id, status: 'SETTLED' } }),
      p.license.count({ where: { skillId: s.id, status: 'ACTIVE' } }),
    ]);
    const offers = s.offers ?? (await this.offers(s.id));
    return {
      id: s.id, slug: s.slug, name: s.name, description: s.description, category: s.category, kind: s.kind, version: s.version,
      status: s.status, demo: s.demo, executor: s.executor.startsWith('builtin:') ? 'builtin' : s.executor,
      seller: agent ? { agentId: agent.id, name: agent.name, active: agent.isActive, actFeeGas: card.actFeeGas } : null,
      hasAgency: !!s.elevatedFromAgentId,
      inputSchema: s.inputSchema, outputSchema: s.outputSchema, dependencies: deps.filter(Boolean),
      offers: offers.filter((o) => o.active).map((o) => this.offerView(o)), stats: { callsServed: served, activeLicenses: licensees },
    };
  }

  async licenseView(l: License) {
    const names = await this.d.prisma.agent.findMany({ where: { id: { in: [l.licensorAgentId, l.licenseeAgentId].filter(Boolean) as string[] } }, select: { id: true, name: true } });
    const live = this.licenseProblems(l).length === 0;
    return {
      id: l.id, source: l.source, skillRef: l.skillRef, skillName: l.skillName, mode: l.mode, status: live ? 'ACTIVE' : (this.licenseProblems(l)[0] ?? '').replace('LICENSE_', ''),
      licensor: l.licensorAgentId ? { agentId: l.licensorAgentId, name: names.find((n) => n.id === l.licensorAgentId)?.name ?? null } : null,
      licenseeAgentId: l.licenseeAgentId, priceGas: l.priceGas, callsTotal: l.callsTotal, callsUsed: l.callsUsed, prepaidGas: l.prepaidGas,
      sublicensable: l.sublicensable, royaltyBps: l.royaltyBps, capMinor: l.capMinor, usedMinor: l.usedMinor, expiresAt: l.expiresAt, createdAt: l.createdAt,
    };
  }
}
