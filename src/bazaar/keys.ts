import { KeyObject, createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

// ---------------------------------------------------------------------------
// Ed25519 identities for AgentBazaar, held custodially by PayPali.
// Private keys are stored AES-256-GCM encrypted under PAYPALI_KEY_ENCRYPTION_KEY
// (32 bytes, base64). Without it a random per-process key is used, which is only
// acceptable because the dev database is in-memory too: set the env var for any
// persistent database or every stored key becomes unreadable on restart.
// Wire formats match AgentBazaar/core.js exactly (base64url SPKI, canonical JSON).
// ---------------------------------------------------------------------------

const b64u = (b: Buffer) => b.toString('base64url');
export const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Canonical JSON: recursively sorted object keys (same as core.js `canon`). */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + canon((v as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

let warned = false;
function masterKey(): Buffer {
  const env = process.env.PAYPALI_KEY_ENCRYPTION_KEY;
  if (env) {
    const k = Buffer.from(env, 'base64');
    if (k.length !== 32) throw new Error('PAYPALI_KEY_ENCRYPTION_KEY must be 32 bytes, base64');
    return k;
  }
  const g = globalThis as { __paypaliEphemeralKey?: Buffer };
  if (!g.__paypaliEphemeralKey) {
    g.__paypaliEphemeralKey = randomBytes(32);
    if (!warned && process.env.NODE_ENV !== 'test') {
      warned = true;
      process.stderr.write('[bazaar] PAYPALI_KEY_ENCRYPTION_KEY not set: using an ephemeral key (dev only; stored Bazaar keys die with this process)\n');
    }
  }
  return g.__paypaliEphemeralKey;
}

function seal(plain: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return ['v1', b64u(iv), b64u(c.getAuthTag()), b64u(ct)].join('.');
}

function open(sealed: string): Buffer {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1') throw new Error('UNSUPPORTED_KEY_ENVELOPE');
  const d = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
}

/** Seal a short secret (e.g. a data agent's endpoint HMAC secret) under the same master key. */
export const sealSecret = (plain: string) => seal(Buffer.from(plain, 'utf8'));
export const openSecret = (sealed: string) => open(sealed).toString('utf8');

export class BazaarKey {
  private constructor(private readonly priv: KeyObject, readonly pub: string) {}

  static generate(): { key: BazaarKey; publicKey: string; encPrivateKey: string } {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pub = b64u(publicKey.export({ format: 'der', type: 'spki' }) as Buffer);
    return { key: new BazaarKey(privateKey, pub), publicKey: pub, encPrivateKey: seal(privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer) };
  }

  static load(publicKey: string, encPrivateKey: string): BazaarKey {
    const priv = createPrivateKey({ key: open(encPrivateKey), format: 'der', type: 'pkcs8' });
    const derived = b64u(createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer);
    if (derived !== publicKey) throw new Error('KEY_MISMATCH');
    return new BazaarKey(priv, publicKey);
  }

  sign(message: string): string {
    return b64u(sign(null, Buffer.from(message, 'utf8'), this.priv));
  }
}

/** Verify a Bazaar-signed {body, sig} document (quote, receipt) with the market's SPKI public key. */
export function verifyMarketDoc(doc: { body: unknown; sig: string } | null | undefined, marketPub: string): boolean {
  if (!doc || typeof doc.sig !== 'string') return false;
  try {
    const key = createPublicKey({ key: Buffer.from(marketPub, 'base64url'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(canon(doc.body), 'utf8'), key, Buffer.from(doc.sig, 'base64url'));
  } catch {
    return false;
  }
}
