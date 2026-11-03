import { Prisma, PrismaClient, PowerOfAgency } from '@prisma/client';
import type { SkillMarket } from '../skills/SkillMarket';
import { canon, sha256hex } from '../bazaar/keys';
import { IdentityIssuer } from '../bazaar/IdentityIssuer';
import { KycService } from '../bazaar/KycService';
import { AgentConnectService } from '../connect/AgentConnectService';
import { BazaarBridge } from '../bazaar/BazaarBridge';
import { MerchantService } from '../merchant/MerchantService';
import { DataAgentService } from '../data/DataAgentService';
import { FundingService } from '../funding/FundingService';
import { ScoreService } from '../agentdev/ScoreService';

// ---------------------------------------------------------------------------
// Agency: the holder ↔ agent relationship.
//
//   Power of Agency   the contract between a holder (owner) and their agent. Each version
//                     freezes the agent's whole authority: objective, spending policy,
//                     capabilities, connections and their mandates, allowance, beneficiary,
//                     data and Bazaar access, Score floor, the agent's duties as a steward,
//                     and the holder's right to stop it. The owner accepts it; PayPali
//                     countersigns it with its identity issuer key. With
//                     PAYPALI_REQUIRE_POWER_OF_AGENCY=1 an agent without an active Power of
//                     Agency cannot pass a Score gate, so it cannot move money.
//
//   Kill switch       one owner action that stops the agent everywhere at once: wallet off,
//                     every external connection revoked, AgentBazaar mandate and merchant
//                     grants revoked, allowance and beneficiary sweeps paused, data
//                     subscriptions cancelled, its data agent listing paused, and the Power of
//                     Agency revoked. Resuming switches the wallet back on; everything else is
//                     re-granted deliberately (new Power of Agency, new connections).
// ---------------------------------------------------------------------------

const err = (c: string) => new Error(c);

export const STEWARD_DUTIES = [
  'Act in the holder’s interest and toward the stated objective, not your own or a third party’s.',
  'Spend only within this instrument: its limits, grants, connections and mandates.',
  'State your honest confidence before acting; your Score stakes it.',
  'Prefer verified counterparties; record what you bought and what it achieved.',
  'Keep the holder’s money separate from the holder’s own accounts: you hold only what was funded to you.',
  'Stop immediately when the holder uses the kill switch or revokes this instrument.',
];

export interface AgencyDeps {
  prisma: PrismaClient;
  score: ScoreService;
  connect?: AgentConnectService | null;
  bazaar?: BazaarBridge | null;
  merchants?: MerchantService | null;
  data?: DataAgentService | null;
  funding?: FundingService | null;
  kyc?: KycService | null;
  issuer?: IdentityIssuer | null;
  now?: () => Date;
}

export class AgencyService {
  private readonly now: () => Date;
  /** Set by the server: the skill market (the kill switch ends the licenses the agent holds). */
  skills: SkillMarket | null = null;
  constructor(private readonly d: AgencyDeps) { this.now = d.now ?? (() => new Date()); }

  /** Make an active Power of Agency a precondition of every Score-gated action. */
  enforce() {
    this.d.score.preconditions.push(async (agentId, db) => {
      const poa = await db.powerOfAgency.findFirst({ where: { agentId, status: 'ACTIVE' }, select: { id: true } });
      return poa ? [] : ['POWER_OF_AGENCY_REQUIRED'];
    });
  }

  // =========================================================================
  // Power of Agency
  // =========================================================================

  /** The terms a new version would have, from the agent's current authority. */
  async draft(ownerId: string, agentId: string, opts: { termDays?: number } = {}) {
    const agent = await this.owned(ownerId, agentId);
    const p = this.d.prisma;
    const owner = await p.owner.findUniqueOrThrow({ where: { id: ownerId } });
    const [skills, gasAcct] = await Promise.all([p.skill.findMany({ where: { agentId, status: { not: 'RETIRED' } }, orderBy: { slug: 'asc' } }), p.agentGasAccount.findUnique({ where: { agentId } })]);
    const [policy, grants, connections, allowance, sweep, score, bazaar, subs, dataAgent, accounts] = await Promise.all([
      p.policy.findFirst({ where: { ownerId, isActive: true }, orderBy: { version: 'desc' } }),
      p.capabilityGrant.findMany({ where: { agentId, revokedAt: null }, orderBy: { capability: 'asc' } }),
      p.agentConnection.findMany({ where: { agentId, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } }),
      p.allowance.findUnique({ where: { agentId } }),
      p.beneficiarySweep.findUnique({ where: { agentId } }),
      p.agentScore.findUnique({ where: { agentId } }),
      p.bazaarAccount.findUnique({ where: { agentId } }),
      p.dataSubscription.findMany({ where: { buyerAgentId: agentId, status: 'ACTIVE' } }),
      p.dataAgent.findFirst({ where: { agentId } }),
      p.agentAccount.findMany({ where: { agentId } }),
    ]);
    const identity = this.d.kyc ? await this.d.kyc.grantFor(ownerId).catch(() => null) : null;
    const nowMs = this.now().getTime();
    const termDays = opts.termDays ?? 365;
    if (!(Number.isInteger(termDays) && termDays >= 1 && termDays <= 730)) throw err('INVALID_TERM');
    const m = (v: bigint | null | undefined) => (v == null ? null : v.toString());
    const dataSlugs = subs.length ? (await p.dataAgent.findMany({ where: { id: { in: subs.map((s) => s.dataAgentId) } } })) : [];
    return {
      instrument: 'Power of Agency',
      holder: { ownerId, email: owner.email, identity: identity ? { assurance: identity.assurance, method: identity.method } : { assurance: 'none' } },
      agent: { id: agent.id, name: agent.name, origin: agent.origin, wallets: accounts.map((a) => a.currency) },
      objective: { type: agent.objectiveType, mandate: agent.objectiveMandate, targetMinor: m(agent.objectiveTargetMinor) },
      duties: STEWARD_DUTIES,
      spendingPolicy: policy ? {
        currency: policy.currency, policyVersion: policy.version, maxPerTransactionMinor: m(policy.maxPerTransactionMinor), maxDailyMinor: m(policy.maxDailyBudgetMinor),
        maxMonthlyMinor: m(policy.maxMonthlyBudgetMinor), humanApprovalAboveMinor: m(policy.requireHumanApprovalAbove),
        allowedRecipients: policy.allowedRecipients, allowedCategories: policy.allowedCategories,
      } : null,
      capabilities: grants.map((g) => ({ capability: g.capability, maxRisk: g.maxRisk, expiresAt: g.expiresAt })),
      connections: connections.map((c) => ({
        id: c.id, provider: c.provider, label: c.label, scopes: c.scopes,
        mandate: { maxPerTxMinor: m(c.maxPerTxMinor), maxDailyMinor: m(c.maxDailyMinor), approvalAboveMinor: m(c.approvalAboveMinor), allowedServices: c.allowedServices, allowRecurring: c.allowRecurring, expiresAt: c.expiresAt },
      })),
      funding: {
        allowance: allowance && allowance.status !== 'CANCELLED' ? { amountMinor: m(allowance.amountMinor), currency: allowance.currency, period: allowance.period, status: allowance.status, fromSavedPayPal: !!allowance.paymentMethodId } : null,
        beneficiary: sweep ? { receiver: sweep.receiver, keepMinor: m(sweep.keepMinor), period: sweep.period, status: sweep.status } : null,
      },
      markets: {
        agentBazaar: bazaar && !bazaar.disabledAt && bazaar.mandateId ? { budgetMinor: m(bazaar.budgetMinor), perPurchaseCapMinor: m(bazaar.capMinor), minTier: bazaar.minTier } : null,
        dataSubscriptions: subs.map((s) => ({ dataAgent: dataSlugs.find((x) => x.id === s.dataAgentId)?.slug ?? s.dataAgentId, monthlyBudgetMinor: m(s.monthlyBudgetMinor) })),
        sellsDataAs: dataAgent ? { slug: dataAgent.slug, status: dataAgent.status } : null,
        // Selling skills is part of what the agent is authorised to do; the owner's fee ceiling bounds what it charges.
        sellsSkills: skills.map((s) => ({ skill: s.slug, name: s.name, version: s.version })),
        gasFeeMaximum: gasAcct ? gasAcct.maxFeeGas : null,
      },
      safety: {
        scoreFloor: score?.floor ?? null, scoreStatus: score?.status ?? 'NOT_DEVELOPED',
        killSwitch: 'The holder may stop this agent at any time from the PayPali dashboard or API. Stopping is immediate and revokes this instrument.',
        suspension: 'If the agent’s Score falls to its floor, PayPali switches it off automatically.',
      },
      term: { effective: new Date(nowMs).toISOString(), expires: new Date(nowMs + termDays * 86_400_000).toISOString() },
    };
  }

  /** Owner act: accept the current terms as a new version. Supersedes the previous one. */
  async sign(ownerId: string, agentId: string, p: { acceptedTermsSha256?: string; termDays?: number } = {}) {
    const agent = await this.owned(ownerId, agentId);
    if (!agent.isActive) throw err('AGENT_STOPPED_RESUME_FIRST');
    const terms = await this.draft(ownerId, agentId, { termDays: p.termDays });
    const { term, ...stable } = terms;
    const termsSha256 = sha256hex(canon(stable));
    // The owner must be accepting what they were shown (the draft's hash), not whatever the terms are now.
    if (p.acceptedTermsSha256 && p.acceptedTermsSha256 !== termsSha256) throw err('TERMS_CHANGED_REVIEW_AGAIN');
    return this.d.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Agent" WHERE id = ${agentId} FOR UPDATE`;
      const last = await tx.powerOfAgency.findFirst({ where: { agentId }, orderBy: { version: 'desc' } });
      const version = (last?.version ?? 0) + 1;
      await tx.powerOfAgency.updateMany({ where: { agentId, status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
      const body = { kind: 'power_of_agency', issuer: this.d.issuer?.id ?? 'paypali', version, agent_id: agentId, owner_id: ownerId, terms_sha256: termsSha256, effective: term.effective, expires: term.expires, accepted_at: this.now().toISOString() };
      const document = this.d.issuer ? this.d.issuer.sign(body) : { body, sig: null };
      const row = await tx.powerOfAgency.create({
        data: { agentId, ownerId, version, terms: JSON.parse(JSON.stringify(terms)) as Prisma.InputJsonValue, termsSha256, document: document as unknown as Prisma.InputJsonValue, acceptedAt: this.now() },
      });
      return this.view(row);
    });
  }

  async current(agentId: string): Promise<{ active: ReturnType<AgencyService['view']> | null; history: Array<Record<string, unknown>> }> {
    const rows = await this.d.prisma.powerOfAgency.findMany({ where: { agentId }, orderBy: { version: 'desc' }, take: 20 });
    const active = rows.find((r) => r.status === 'ACTIVE') ?? null;
    if (active && new Date((active.terms as any).term.expires).getTime() < this.now().getTime()) {
      await this.d.prisma.powerOfAgency.update({ where: { id: active.id }, data: { status: 'REVOKED', revokedAt: this.now(), revokeReason: 'EXPIRED' } });
      return this.current(agentId);
    }
    return { active: active ? this.view(active) : null, history: rows.map((r) => ({ version: r.version, status: r.status, acceptedAt: r.acceptedAt, revokedAt: r.revokedAt, revokeReason: r.revokeReason, termsSha256: r.termsSha256 })) };
  }

  /** Has the authority changed since the active version was signed? */
  async changedSinceSigned(ownerId: string, agentId: string) {
    const { active } = await this.current(agentId);
    const { term, ...stable } = await this.draft(ownerId, agentId);
    const draftSha = sha256hex(canon(stable));
    return { draftTermsSha256: draftSha, activeTermsSha256: active?.termsSha256 ?? null, changed: !active || active.termsSha256 !== draftSha };
  }

  /** Anyone holding a Power of Agency document can check it here (signature, status). */
  async verify(doc: { body?: any; sig?: string | null }) {
    if (!doc?.body || doc.body.kind !== 'power_of_agency') return { valid: false, reason: 'NOT_A_POWER_OF_AGENCY' };
    const sigOk = this.d.issuer ? this.d.issuer.verifyOwn(doc as any) : false;
    const row = await this.d.prisma.powerOfAgency.findUnique({ where: { agentId_version: { agentId: String(doc.body.agent_id), version: Number(doc.body.version) } } });
    if (!row || row.termsSha256 !== doc.body.terms_sha256) return { valid: false, reason: 'UNKNOWN_INSTRUMENT', signatureValid: sigOk };
    return { valid: sigOk && row.status === 'ACTIVE', signatureValid: sigOk, status: row.status, revokedAt: row.revokedAt, revokeReason: row.revokeReason };
  }

  private view(r: PowerOfAgency) {
    return { id: r.id, agentId: r.agentId, version: r.version, status: r.status, termsSha256: r.termsSha256, terms: r.terms, document: r.document, acceptedAt: r.acceptedAt, revokedAt: r.revokedAt, revokeReason: r.revokeReason };
  }

  // =========================================================================
  // Kill switch
  // =========================================================================

  async stop(ownerId: string, agentId: string, reason = 'Stopped by holder') {
    const agent = await this.owned(ownerId, agentId);
    const why = String(reason).slice(0, 200) || 'Stopped by holder';
    const p = this.d.prisma;
    // 1. Money first: the wallet refuses every debit from here on (Score gates, Gas, Bazaar, data, payouts).
    await p.agent.update({ where: { id: agentId }, data: { isActive: false } });
    const effects: Record<string, unknown> = { walletFrozen: true, wasActive: agent.isActive };
    // 2. Everything that could act or charge on the agent's behalf.
    const conns = await p.agentConnection.findMany({ where: { agentId, status: 'ACTIVE' } });
    if (this.d.connect) for (const c of conns) await this.d.connect.revoke(ownerId, c.id).catch(() => undefined);
    effects.connectionsRevoked = conns.length;
    if (this.d.bazaar) effects.bazaar = await this.d.bazaar.disable(ownerId, agentId).then(() => 'mandate revoked').catch((e: Error) => (e.message === 'BAZAAR_NOT_ENABLED' ? 'not enabled' : `error: ${e.message}`));
    const grants = await p.merchantGrant.findMany({ where: { agentId, status: 'ACTIVE' } });
    if (this.d.merchants) for (const g of grants) await this.d.merchants.revokeGrant(ownerId, g.id).catch(() => undefined);
    effects.merchantGrantsRevoked = grants.length;
    if (this.d.funding) Object.assign(effects, await this.d.funding.pauseAll(agentId));
    const subs = await p.dataSubscription.findMany({ where: { buyerAgentId: agentId, status: 'ACTIVE' } });
    if (this.d.data) for (const s of subs) await this.d.data.cancelSubscription({ ownerId }, s.id).catch(() => undefined);
    effects.dataSubscriptionsCancelled = subs.length;
    const listed = await p.dataAgent.updateMany({ where: { agentId, status: 'ACTIVE' }, data: { status: 'PAUSED' } });
    effects.dataAgentListingsPaused = listed.count;
    // Skill licenses it holds end (unused prepaid Gas comes back); the skills it sells stop selling while it is stopped.
    const held = await p.license.findMany({ where: { licenseeAgentId: agentId, source: 'NATIVE', status: 'ACTIVE' } });
    for (const l of held) await this.skills?.revoke(ownerId, l.id).catch(() => undefined);
    effects.skillLicensesRevoked = held.length;
    effects.skillsNotSelling = await p.skill.count({ where: { agentId, status: 'ACTIVE' } });
    // 3. The instrument itself.
    const revoked = await p.powerOfAgency.updateMany({ where: { agentId, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: this.now(), revokeReason: `KILL_SWITCH: ${why}` } });
    effects.powerOfAgencyRevoked = revoked.count > 0;
    await p.agentStopEvent.create({ data: { agentId, ownerId, action: 'STOP', reason: why, effects: effects as Prisma.InputJsonValue } });
    return { agentId, stopped: true, reason: why, effects };
  }

  async resume(ownerId: string, agentId: string, reason = 'Resumed by holder') {
    await this.owned(ownerId, agentId);
    const score = await this.d.prisma.agentScore.findUnique({ where: { agentId } });
    if (score?.status === 'SUSPENDED') throw err('SCORE_SUSPENDED');
    await this.d.prisma.agent.update({ where: { id: agentId }, data: { isActive: true } });
    const next = ['Sign a new Power of Agency (the old one was revoked).', 'Reconnect external assistants (their tokens were revoked).', 'Resume the allowance and beneficiary sweep if you want them.'];
    await this.d.prisma.agentStopEvent.create({ data: { agentId, ownerId, action: 'RESUME', reason: String(reason).slice(0, 200), effects: { next } } });
    return { agentId, stopped: false, next };
  }

  async stopHistory(agentId: string) {
    return this.d.prisma.agentStopEvent.findMany({ where: { agentId }, orderBy: { createdAt: 'desc' }, take: 20 });
  }

  private async owned(ownerId: string, agentId: string) {
    const a = await this.d.prisma.agent.findUnique({ where: { id: agentId } });
    if (!a || a.ownerId !== ownerId) throw err('AGENT_NOT_OWNED');
    return a;
  }
}
