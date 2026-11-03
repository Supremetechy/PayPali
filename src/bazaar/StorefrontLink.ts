import { createHash, createPublicKey } from 'node:crypto';
import { AgentDevService } from '../agentdev/AgentDevService';
import { MerchantService } from '../merchant/MerchantService';
import { KycService } from './KycService';
import { BazaarStorefrontLink, PrismaClient, RiskClass } from '@prisma/client';

// ---------------------------------------------------------------------------
// Connect PayPali: links a Solutions Farm storefront key to the owner's PayPali account.
//
//   BUY   the storefront's browser principal key may spend through a merchant grant
//         that is BOUND to that key (the Bazaar refuses a mandate from any other key),
//         paid from one of the owner's agents. Also returns an identity credential for
//         the key, so the human's confirmations count as evidence.
//   SELL  the storefront's vendor key gets an identity credential and a payout binding,
//         so the vendor is listed as verified and paid out into one of the owner's agents.
//
// Every link is an owner act (the owner's PayPali session), recorded, listed in the
// Marketplace, and revocable there: revoking BUY revokes the grant; revoking SELL stops
// PayPali paying that vendor key into that agent.
// ---------------------------------------------------------------------------

export type LinkRole = 'BUY' | 'SELL';
const MAX_BUDGET = 1_000_000n;          // $10,000 per storefront link
const GRANT_DAYS = 30;

export const vendorIdOf = (pub: string) => 'vnd_' + createHash('sha256').update(pub, 'utf8').digest('hex').slice(0, 16);

/** A base64url SPKI Ed25519 public key, as WebCrypto and the Bazaar produce. */
export function isEd25519Pub(pub: unknown): pub is string {
  if (typeof pub !== 'string' || !/^[A-Za-z0-9_-]{40,120}$/.test(pub)) return false;
  try { return createPublicKey({ key: Buffer.from(pub, 'base64url'), format: 'der', type: 'spki' }).asymmetricKeyType === 'ed25519'; } catch { return false; }
}

export interface StorefrontLinkDeps {
  prisma: PrismaClient;
  dev: AgentDevService;
  merchants: MerchantService;
  kyc: KycService | null;
  merchantId: string;
  now?: () => Date;
}

export class StorefrontLinkService {
  constructor(private readonly d: StorefrontLinkDeps) {}
  private now() { return this.d.now ? this.d.now() : new Date(); }

  async link(ownerId: string, input: { role: LinkRole; agentId: string; pub: string; budgetMinor?: bigint }) {
    const { prisma } = this.d;
    if (input.role !== 'BUY' && input.role !== 'SELL') throw new Error('BAD_ROLE');
    if (!isEd25519Pub(input.pub)) throw new Error('BAD_STOREFRONT_KEY');
    const agent = await prisma.agent.findUnique({ where: { id: input.agentId } });
    if (!agent || agent.ownerId !== ownerId) throw new Error('AGENT_NOT_OWNED');
    if (!agent.isActive) throw new Error('AGENT_INACTIVE');
    const credential = this.d.kyc ? await this.d.kyc.credentialFor(ownerId, input.pub) : null;

    if (input.role === 'BUY') {
      const budget = input.budgetMinor ?? 10_000n;
      if (!(budget > 0n && budget <= MAX_BUDGET)) throw new Error('INVALID_BUDGET');
      await this.d.dev.score.open(agent.id);
      await this.d.dev.skills.grantCapability(ownerId, agent.id, 'bazaar.purchase', 'HIGH' as RiskClass);
      // One live grant per storefront key: re-linking replaces the previous one.
      await this.revokeWhere(ownerId, { role: 'BUY', pub: input.pub });
      const grant = await this.d.merchants.createGrant(ownerId, agent.id, {
        merchantId: this.d.merchantId, maxMinor: budget, currency: 'USD',
        expiresAt: new Date(this.now().getTime() + GRANT_DAYS * 86_400_000), principalPub: input.pub,
      });
      const link = await prisma.bazaarStorefrontLink.create({ data: { ownerId, agentId: agent.id, role: 'BUY', pub: input.pub, grantId: grant.grantId, createdAt: this.now() } });
      return { link: await this.view(link), agent: { id: agent.id, name: agent.name }, grant, credential };
    }

    if (!this.d.kyc) throw new Error('IDENTITY_ISSUER_NOT_CONFIGURED');
    const binding = await this.d.kyc.payoutBinding(ownerId, agent.id, input.pub);
    // The Bazaar holds one vendor key per person, so a new vendor key retires the owner's previous one here too.
    await this.revokeWhere(ownerId, { role: 'SELL' });
    const link = await prisma.bazaarStorefrontLink.create({ data: { ownerId, agentId: agent.id, role: 'SELL', pub: input.pub, vendorId: vendorIdOf(input.pub), createdAt: this.now() } });
    return { link: await this.view(link), agent: { id: agent.id, name: agent.name }, credential, binding };
  }

  async list(ownerId: string) {
    const rows = await this.d.prisma.bazaarStorefrontLink.findMany({ where: { ownerId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return Promise.all(rows.map((r) => this.view(r)));
  }

  /** Vendor ids the owner sells under (active SELL links): the Marketplace tags these listings as theirs. */
  async vendorIds(ownerId: string) {
    const rows = await this.d.prisma.bazaarStorefrontLink.findMany({ where: { ownerId, role: 'SELL', revokedAt: null } });
    return [...new Set(rows.map((r) => r.vendorId).filter((x): x is string => !!x))];
  }

  async revoke(ownerId: string, linkId: string) {
    const l = await this.d.prisma.bazaarStorefrontLink.findUnique({ where: { id: linkId } });
    if (!l || l.ownerId !== ownerId) throw new Error('LINK_NOT_FOUND');
    if (!l.revokedAt) await this.revokeRow(l);
    return this.view((await this.d.prisma.bazaarStorefrontLink.findUnique({ where: { id: linkId } }))!);
  }

  /**
   * Payout guard (with the KYC binding check): a vendor key the owner unlinked from an agent
   * is not paid into that agent any more, even though the signed binding is still valid.
   */
  async payoutBlocked(vendorPub: string | undefined, toAgentId: string): Promise<string | null> {
    if (!vendorPub) return null;
    const rows = await this.d.prisma.bazaarStorefrontLink.findMany({ where: { role: 'SELL', pub: vendorPub, agentId: toAgentId } });
    if (!rows.length) return null;                                   // bound outside the storefront flow (API): unaffected
    return rows.some((r) => !r.revokedAt) ? null : 'PAYOUT_UNLINKED_BY_OWNER';
  }

  private async revokeWhere(ownerId: string, w: { role: LinkRole; pub?: string }) {
    const rows = await this.d.prisma.bazaarStorefrontLink.findMany({ where: { ownerId, role: w.role, ...(w.pub ? { pub: w.pub } : {}), revokedAt: null } });
    for (const r of rows) await this.revokeRow(r);
  }

  private async revokeRow(l: BazaarStorefrontLink) {
    if (l.grantId) await this.d.merchants.revokeGrant(l.ownerId, l.grantId).catch(() => undefined);
    await this.d.prisma.bazaarStorefrontLink.update({ where: { id: l.id }, data: { revokedAt: this.now() } });
  }

  private async view(l: BazaarStorefrontLink) {
    const agent = await this.d.prisma.agent.findUnique({ where: { id: l.agentId } });
    const grant = l.grantId ? await this.d.prisma.merchantGrant.findUnique({ where: { id: l.grantId } }) : null;
    const live = !l.revokedAt && (!grant || (grant.status === 'ACTIVE' && (!grant.expiresAt || grant.expiresAt > this.now())));
    return {
      id: l.id, role: l.role as LinkRole, agentId: l.agentId, agentName: agent?.name ?? null, keyTail: l.pub.slice(-10), vendorId: l.vendorId,
      status: l.revokedAt ? 'REVOKED' : live ? 'ACTIVE' : grant?.status === 'REVOKED' ? 'REVOKED' : 'EXPIRED',
      grant: grant ? { id: grant.id, maxMinor: grant.maxMinor, usedMinor: grant.usedMinor, expiresAt: grant.expiresAt } : null,
      createdAt: l.createdAt, revokedAt: l.revokedAt,
    };
  }
}
