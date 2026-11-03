import { createHmac, randomBytes } from 'node:crypto';
import { KycSession, Prisma, PrismaClient } from '@prisma/client';
import { Assurance, IdentityIssuer, IdentityMethod, PayoutBinding, Revocation } from './IdentityIssuer';
import { KycProvider, VerifiedIdentity } from './kycProviders';

// ---------------------------------------------------------------------------
// KycService: PayPali as an identity authority for AgentBazaar. PayPal is the
// identity provider (Log in with PayPal, see kycProviders.ts).
//
//   start()        owner is sent to PayPal to sign in and share their PayPal
//                  account attributes (verified status + payer id)
//   complete()     PayPal's callback: exchange the code, require a VERIFIED
//                  PayPal account, fingerprint the payer id (keyed HMAC), bind
//                  it to this owner, drop the raw value
//   credentialFor  kyc credential (person-level subject) when verified, else a
//                  dev credential (account-level subject)
//   payoutBinding  "PayPali agent A belongs to the same subject as vendor key V"
//   revoke         signed revocations, pushed to the Bazaar and published as a feed
//
// One PayPal account = one verified PayPali owner: if the fingerprint already
// belongs to another owner, the session ends DUPLICATE (manual review).
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const OPEN: KycSession['status'][] = ['PENDING', 'REQUIRES_INPUT'];

export interface IdentityGrant { subject: string; assurance: Assurance; method: IdentityMethod; notAfter?: number }

export interface KycOptions {
  validityMs?: number;                 // how long a verification lasts before re-verification (default 365 d)
  fingerprintKey?: Buffer;             // 32 bytes; PAYPALI_KYC_FINGERPRINT_KEY
  revocationSinks?: string[];          // Bazaar base URLs to push revocations to
  fetch?: typeof fetch;
  now?: () => Date;
}

let warned = false;
export function fingerprintKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const v = env.PAYPALI_KYC_FINGERPRINT_KEY;
  if (v) {
    const k = Buffer.from(v, 'base64');
    if (k.length !== 32) throw new Error('PAYPALI_KYC_FINGERPRINT_KEY must be 32 bytes, base64');
    return k;
  }
  if (env.NODE_ENV === 'production') throw new Error('PAYPALI_KYC_FINGERPRINT_KEY is required in production');
  if (!warned && env.NODE_ENV !== 'test') { warned = true; process.stderr.write('[kyc] PAYPALI_KYC_FINGERPRINT_KEY not set: ephemeral key (dev only; dedup resets on restart)\n'); }
  return randomBytes(32);
}

/** Case- and punctuation-insensitive identifier form. */
const norm = (s: string) => s.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');

export class KycService {
  private readonly validity: number;
  private readonly fpKey: Buffer;
  private readonly f: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly prisma: PrismaClient, readonly issuer: IdentityIssuer, readonly provider: KycProvider | null, private readonly opts: KycOptions = {}) {
    this.validity = opts.validityMs ?? 365 * DAY;
    this.fpKey = opts.fingerprintKey ?? fingerprintKeyFromEnv();
    this.f = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  /** Keyed fingerprints of a verified identity. Exported for tests; the raw identifiers are never stored. */
  fingerprints(id: VerifiedIdentity): Array<{ kind: string; hash: string }> {
    const h = (s: string) => createHmac('sha256', this.fpKey).update(s, 'utf8').digest('hex');
    const out = (id?.identifiers ?? []).filter((x) => x && x.kind && norm(String(x.value ?? '')))
      .map((x) => ({ kind: x.kind, hash: h(`${x.kind}|${norm(String(x.value))}`) }));
    if (!out.length) throw new Error('KYC_RESULT_INCOMPLETE');
    return out;
  }

  // -------------------------------------------------------------------------
  // Owner flow
  // -------------------------------------------------------------------------
  async start(ownerId: string) {
    if (!this.provider) throw new Error('KYC_NOT_CONFIGURED');
    if (!(await this.prisma.owner.findUnique({ where: { id: ownerId } }))) throw new Error('OWNER_NOT_FOUND');
    if (await this.revokedOwner(ownerId)) throw new Error('IDENTITY_REVOKED');
    const live = await this.livePerson(ownerId);
    if (live) return { status: 'VERIFIED' as const, alreadyVerified: true, expiresAt: live.expiresAt };
    // Reuse an unfinished check rather than opening a new one each time.
    const open = await this.prisma.kycSession.findFirst({ where: { ownerId, provider: this.provider.id, status: { in: OPEN } }, orderBy: { createdAt: 'desc' } });
    if (open?.providerSessionId) {
      try {
        const r = await this.provider.resume(open.providerSessionId);
        return { sessionId: open.id, provider: this.provider.id, status: open.status, url: r.url ?? undefined, resumed: true };
      } catch { await this.endSession(open.id, 'FAILED', 'session_lost'); }
    }
    const row = await this.prisma.kycSession.create({ data: { ownerId, provider: this.provider.id } });
    try {
      const s = await this.provider.createSession({ sessionRef: row.id });
      await this.prisma.kycSession.update({ where: { id: row.id }, data: { providerSessionId: s.providerSessionId, status: 'PENDING' } });
      return { sessionId: row.id, provider: this.provider.id, status: 'PENDING' as const, url: s.url ?? undefined };
    } catch (e) {
      await this.prisma.kycSession.update({ where: { id: row.id }, data: { status: 'FAILED', lastError: String((e as Error).message).slice(0, 200) } });
      throw e;
    }
  }

  async status(ownerId: string) {
    const person = await this.prisma.kycPerson.findUnique({ where: { ownerId } });
    const last = await this.prisma.kycSession.findFirst({ where: { ownerId }, orderBy: { createdAt: 'desc' } });
    const revoked = await this.revokedOwner(ownerId);
    const live = !!person && person.expiresAt > this.now() && !revoked;
    return {
      provider: this.provider?.id ?? null,
      assurance: revoked ? null : live ? 'kyc' : 'dev',
      verified: live, method: person?.method ?? null, verifiedAt: person?.verifiedAt ?? null, expiresAt: person?.expiresAt ?? null,
      revoked: !!revoked, revokedReason: revoked?.reason ?? null,
      lastSession: last ? { sessionId: last.id, status: last.status, lastError: last.lastError, updatedAt: last.updatedAt } : null,
    };
  }

  // -------------------------------------------------------------------------
  // Provider callback (PayPal redirect, or the dev sandbox page)
  // -------------------------------------------------------------------------
  /**
   * Finish a check. `providerSessionId` is the OAuth `state` PayPal echoes back: it must match an open session,
   * and only one callback can claim it (the PENDING/REQUIRES_INPUT -> PROCESSING step is atomic).
   */
  async complete(providerSessionId: string, params: Record<string, string | undefined>): Promise<{ sessionId: string; status: KycSession['status']; replayed?: boolean; personId?: string }> {
    if (!this.provider) throw new Error('KYC_NOT_CONFIGURED');
    const s = await this.prisma.kycSession.findUnique({ where: { providerSessionId } });
    if (!s || s.provider !== this.provider.id) throw new Error('KYC_SESSION_NOT_FOUND');
    const claimed = await this.prisma.kycSession.updateMany({ where: { id: s.id, status: { in: OPEN } }, data: { status: 'PROCESSING' } });
    if (claimed.count !== 1) return { sessionId: s.id, status: (await this.prisma.kycSession.findUniqueOrThrow({ where: { id: s.id } })).status, replayed: true };

    let result;
    try { result = await this.provider.complete(providerSessionId, params); }
    catch (e) {
      const u = await this.prisma.kycSession.update({ where: { id: s.id }, data: { status: 'REQUIRES_INPUT', lastError: String((e as Error).message).slice(0, 200) } });
      return { sessionId: u.id, status: u.status };
    }
    if (result.status !== 'VERIFIED' || !result.identity) {
      const status = result.status === 'VERIFIED' ? 'REQUIRES_INPUT' : result.status;
      const u = await this.prisma.kycSession.update({ where: { id: s.id }, data: { status, lastError: result.lastError ?? null } });
      return { sessionId: u.id, status: u.status };
    }
    let identity: VerifiedIdentity | null = result.identity;
    const fps = this.fingerprints(identity);
    identity = null; result = null;   // drop the raw identifiers; only keyed hashes leave this function
    return this.bind(s, fps);
  }

  private async bind(s: KycSession, fps: Array<{ kind: string; hash: string }>) {
    const method = this.provider!.method;
    if (await this.revokedOwner(s.ownerId)) return this.endSession(s.id, 'FAILED', 'identity_revoked');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await this.prisma.$transaction(async (tx) => {
          const known = await tx.kycFingerprint.findMany({ where: { hash: { in: fps.map((x) => x.hash) } }, include: { person: true } });
          if (known.some((k) => k.person.ownerId !== s.ownerId)) return { duplicate: true as const };
          const now = this.now();
          const p = await tx.kycPerson.upsert({
            where: { ownerId: s.ownerId },
            update: { method, verifiedAt: now, expiresAt: new Date(now.getTime() + this.validity) },
            create: { ownerId: s.ownerId, method, verifiedAt: now, expiresAt: new Date(now.getTime() + this.validity) },
          });
          const mine = new Set(known.map((k) => k.hash));
          for (const fp of fps) if (!mine.has(fp.hash)) await tx.kycFingerprint.create({ data: { hash: fp.hash, kind: fp.kind, personId: p.id } });
          await tx.kycSession.update({ where: { id: s.id }, data: { status: 'VERIFIED', personId: p.id, lastError: null } });
          return { personId: p.id };
        });
        if ('duplicate' in out) return this.endSession(s.id, 'DUPLICATE', 'paypal_account_already_verified_on_another_owner');
        return { sessionId: s.id, status: 'VERIFIED' as const, personId: out.personId };
      } catch (e) {
        if (attempt === 0 && isUnique(e)) continue;   // a concurrent check bound a fingerprint first: re-evaluate
        throw e;
      }
    }
    return this.endSession(s.id, 'DUPLICATE', 'paypal_account_already_verified_on_another_owner');
  }

  private async endSession(id: string, status: 'DUPLICATE' | 'FAILED', lastError: string) {
    const u = await this.prisma.kycSession.update({ where: { id }, data: { status, lastError } });
    return { sessionId: u.id, status: u.status };
  }

  // -------------------------------------------------------------------------
  // Issuing
  // -------------------------------------------------------------------------
  private livePerson(ownerId: string) {
    return this.prisma.kycPerson.findFirst({ where: { ownerId, expiresAt: { gt: this.now() } } });
  }
  private revokedOwner(ownerId: string) {
    return this.prisma.identityRevocation.findFirst({ where: { ownerId, issuer: this.issuer.id } });
  }

  /** The subject PayPali vouches for, and how strongly. Throws IDENTITY_REVOKED. */
  async grantFor(ownerId: string): Promise<IdentityGrant> {
    if (await this.revokedOwner(ownerId)) throw new Error('IDENTITY_REVOKED');
    const p = await this.livePerson(ownerId);
    if (p) return { subject: this.issuer.personSubject(p.id), assurance: 'kyc', method: p.method as IdentityMethod, notAfter: p.expiresAt.getTime() };
    return { subject: this.issuer.accountSubject(ownerId), assurance: 'dev', method: 'account' };
  }

  async credentialFor(ownerId: string, principalPub: string, opts: { ttlMs?: number } = {}) {
    if (!(await this.prisma.owner.findUnique({ where: { id: ownerId } }))) throw new Error('OWNER_NOT_FOUND');
    const g = await this.grantFor(ownerId);
    return this.issuer.issueCredential({ subject: g.subject, principalPub, assurance: g.assurance, method: g.method, notAfter: g.notAfter, ttlMs: opts.ttlMs });
  }

  /** Owner act: authorise a Bazaar vendor key to be paid out to one of the owner's agents. */
  async payoutBinding(ownerId: string, agentId: string, vendorPub: string) {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.ownerId !== ownerId) throw new Error('AGENT_NOT_OWNED');
    if (!agent.isActive) throw new Error('AGENT_INACTIVE');
    const g = await this.grantFor(ownerId);
    return this.issuer.issuePayoutBinding({ subject: g.subject, vendorPub, agentId, notAfter: g.notAfter });
  }

  /** PayPali-side check before paying a vendor: the binding is ours, for this agent, and still names its owner's current subject. */
  async verifyPayoutBinding(binding: PayoutBinding | null | undefined, toAgentId: string): Promise<string | null> {
    if (!binding) return 'PAYOUT_BINDING_REQUIRED';
    if (!this.issuer.verifyOwn(binding) || binding.body.kind !== 'payout_binding') return 'PAYOUT_BINDING_INVALID';
    if (binding.body.paypali_agent_id !== toAgentId) return 'PAYOUT_BINDING_AGENT_MISMATCH';
    if (!(binding.body.exp > this.now().getTime())) return 'PAYOUT_BINDING_EXPIRED';
    const agent = await this.prisma.agent.findUnique({ where: { id: toAgentId } });
    if (!agent) return 'RECIPIENT_NOT_FOUND';
    try {
      const g = await this.grantFor(agent.ownerId);
      if (g.subject !== binding.body.subject) return 'PAYOUT_BINDING_SUBJECT_CHANGED';
    } catch { return 'PAYOUT_BINDING_REVOKED'; }
    return null;
  }

  // -------------------------------------------------------------------------
  // Revocation
  // -------------------------------------------------------------------------
  /** Admin act (fraud, chargeback abuse, account takeover). Revokes every subject the owner was vouched under. */
  async revoke(ownerId: string, reason: string) {
    if (!reason?.trim()) throw new Error('REASON_REQUIRED');
    const subjects = [this.issuer.accountSubject(ownerId)];
    const person = await this.prisma.kycPerson.findUnique({ where: { ownerId } });
    if (person) subjects.push(this.issuer.personSubject(person.id));
    const docs: Revocation[] = [];
    for (const subject of subjects) {
      const existing = await this.prisma.identityRevocation.findUnique({ where: { issuer_subject: { issuer: this.issuer.id, subject } } });
      if (existing) { docs.push(existing.doc as unknown as Revocation); continue; }
      const doc = this.issuer.issueRevocation(subject, reason);
      await this.prisma.identityRevocation.create({ data: { ownerId, issuer: this.issuer.id, subject, reason: doc.body.reason, doc: doc as unknown as Prisma.InputJsonValue } })
        .catch((e) => { if (!isUnique(e)) throw e; });
      docs.push(doc);
    }
    const pushed = await this.push(docs);
    return { revoked: subjects.length, pushed };
  }

  /** Signed revocations, newest first: the Bazaar polls this (revocations_url). */
  async revocationFeed(since?: number) {
    const rows = await this.prisma.identityRevocation.findMany({
      where: { issuer: this.issuer.id, ...(since ? { createdAt: { gt: new Date(since) } } : {}) }, orderBy: { createdAt: 'desc' }, take: 1000,
    });
    return { issuer: this.issuer.id, revocations: rows.map((r) => r.doc) };
  }

  private async push(docs: Revocation[]) {
    let ok = 0;
    for (const base of this.opts.revocationSinks ?? []) {
      for (const doc of docs) {
        try {
          const r = await this.f(base.replace(/\/+$/, '') + '/v1/identity/revocations', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revocation: doc }), signal: AbortSignal.timeout(8000),
          });
          if (r.ok) ok++;
        } catch { /* the Bazaar also pulls the feed */ }
      }
    }
    return ok;
  }
}

function isUnique(e: unknown) {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return true;
  const x = e as { cause?: { kind?: string; originalCode?: string }; message?: string } | null;
  return !!x && (x.cause?.kind === 'UniqueConstraintViolation' || x.cause?.originalCode === '23505' || /duplicate key value violates unique constraint/.test(x.message ?? ''));
}
