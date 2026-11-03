import { KeyObject, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { canon, sha256hex } from './keys';

// ---------------------------------------------------------------------------
// PayPali's signing key for AgentBazaar trust documents.
//
//   identity credential  "this Bazaar principal key belongs to subject S"
//   payout binding       "PayPali agent A belongs to subject S, and S runs vendor key V"
//   revocation           "subject S is no longer vouched for"
//
// The subject is opaque and issuer-scoped. What it identifies depends on the
// assurance behind it (decided by KycService, not here):
//   dev  sha256(issuerPub ":" ownerId)            one PayPali ACCOUNT
//   kyc  sha256(issuerPub ":person:" kycPersonId) one VERIFIED PAYPAL ACCOUNT
//        holder, however many PayPali accounts they open (dedup by PayPal payer id)
//
// Key: PAYPALI_IDENTITY_ISSUER_KEY = Ed25519 PKCS#8 DER, base64url.
// ---------------------------------------------------------------------------

export type Assurance = 'dev' | 'kyc';
export type IdentityMethod = 'account' | 'paypal_verified_account' | 'sandbox';

export interface SignedDoc<B> { body: B; sig: string }

export interface IdentityBody {
  kind: 'identity'; issuer: string; subject: string; principal_pub: string; level: 'human' | 'org';
  assurance: Assurance; method: IdentityMethod; iat: number; exp: number;
}
export type IdentityCredential = SignedDoc<IdentityBody>;

export interface PayoutBindingBody {
  kind: 'payout_binding'; issuer: string; subject: string; vendor_pub: string; paypali_agent_id: string; iat: number; exp: number;
}
export type PayoutBinding = SignedDoc<PayoutBindingBody>;

export interface RevocationBody { kind: 'revocation'; issuer: string; subject: string; reason: string; iat: number }
export type Revocation = SignedDoc<RevocationBody>;

const DAY = 86_400_000;

export class IdentityIssuer {
  readonly publicKey: string;
  private constructor(private readonly priv: KeyObject, readonly id: string, private readonly now: () => number = Date.now) {
    this.publicKey = (createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url');
  }

  static fromPkcs8(pkcs8: string, id = 'paypali', now?: () => number) {
    return new IdentityIssuer(createPrivateKey({ key: Buffer.from(pkcs8, 'base64url'), format: 'der', type: 'pkcs8' }), id, now);
  }

  static generate(id = 'paypali', now?: () => number) {
    const { privateKey } = generateKeyPairSync('ed25519');
    return { issuer: new IdentityIssuer(privateKey, id, now), pkcs8: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64url') };
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): IdentityIssuer | null {
    const k = env.PAYPALI_IDENTITY_ISSUER_KEY;
    return k ? IdentityIssuer.fromPkcs8(k, env.PAYPALI_IDENTITY_ISSUER_ID ?? 'paypali') : null;
  }

  /** Account-level subject (dev assurance). */
  accountSubject(ownerId: string) { return sha256hex(`${this.publicKey}:${ownerId}`); }
  /** Person-level subject (kyc assurance). */
  personSubject(personId: string) { return sha256hex(`${this.publicKey}:person:${personId}`); }
  /** @deprecated use accountSubject */
  subjectFor(ownerId: string) { return this.accountSubject(ownerId); }

  private signBody<B extends object>(body: B): SignedDoc<B> {
    return { body, sig: sign(null, Buffer.from(canon(body), 'utf8'), this.priv).toString('base64url') };
  }

  /** Sign an arbitrary issuer document (data-subject consent, data query receipts). The body must name this issuer. */
  sign<B extends { kind: string; issuer: string }>(body: B): SignedDoc<B> {
    if (body.issuer !== this.id) throw new Error('ISSUER_MISMATCH');
    return this.signBody(body);
  }

  /** True when `doc` was signed by this issuer (and names it). */
  verifyOwn(doc: { body?: { issuer?: string }; sig?: string } | null | undefined): boolean {
    if (!doc || !doc.body || typeof doc.sig !== 'string' || doc.body.issuer !== this.id) return false;
    try {
      return verify(null, Buffer.from(canon(doc.body), 'utf8'), createPublicKey({ key: Buffer.from(this.publicKey, 'base64url'), format: 'der', type: 'spki' }), Buffer.from(doc.sig, 'base64url'));
    } catch { return false; }
  }

  issueCredential(p: { subject: string; principalPub: string; assurance: Assurance; method: IdentityMethod; level?: 'human' | 'org'; ttlMs?: number; notAfter?: number }): IdentityCredential {
    assertSpki(p.principalPub, 'INVALID_PRINCIPAL_KEY');
    const iat = this.now();
    let exp = iat + Math.min(Math.max(p.ttlMs ?? 30 * DAY, 60_000), 365 * DAY);
    if (p.notAfter !== undefined) exp = Math.min(exp, p.notAfter);
    if (exp <= iat) throw new Error('IDENTITY_EXPIRED');
    return this.signBody({ kind: 'identity' as const, issuer: this.id, subject: p.subject, principal_pub: p.principalPub, level: p.level ?? 'human',
      assurance: p.assurance, method: p.method, iat, exp });
  }

  /** Back-compat: account-level dev credential. */
  issue(ownerId: string, principalPub: string, opts: { level?: 'human' | 'org'; ttlMs?: number } = {}): IdentityCredential {
    if (!ownerId) throw new Error('OWNER_REQUIRED');
    return this.issueCredential({ subject: this.accountSubject(ownerId), principalPub, assurance: 'dev', method: 'account', ...opts });
  }

  issuePayoutBinding(p: { subject: string; vendorPub: string; agentId: string; ttlMs?: number; notAfter?: number }): PayoutBinding {
    assertSpki(p.vendorPub, 'INVALID_VENDOR_KEY');
    const iat = this.now();
    let exp = iat + Math.min(Math.max(p.ttlMs ?? 180 * DAY, 60_000), 365 * DAY);
    if (p.notAfter !== undefined) exp = Math.min(exp, p.notAfter);
    return this.signBody({ kind: 'payout_binding' as const, issuer: this.id, subject: p.subject, vendor_pub: p.vendorPub, paypali_agent_id: p.agentId, iat, exp });
  }

  issueRevocation(subject: string, reason: string): Revocation {
    return this.signBody({ kind: 'revocation' as const, issuer: this.id, subject, reason: String(reason).slice(0, 120), iat: this.now() });
  }

  /** Published at /.well-known/paypali-identity-issuer; a Bazaar registers {id, public_key, revocations_url} in IDENTITY_ISSUERS. */
  descriptor(extra: Record<string, unknown> = {}) {
    return {
      id: this.id, public_key: this.publicKey, alg: 'ed25519', format: 'AgentBazaar identity credential v1',
      assurances: { dev: 'one PayPali account (no identity check)', kyc: 'one PayPal-verified account holder (Log in with PayPal: verified_account), deduplicated by PayPal payer id' },
      ...extra,
    };
  }
}

function assertSpki(pub: string, code: string) {
  try { createPublicKey({ key: Buffer.from(String(pub), 'base64url'), format: 'der', type: 'spki' }); } catch { throw new Error(code); }
}
