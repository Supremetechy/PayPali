'use strict';
// Node signing client for the marketplace API (Node >= 20, zero deps).
// Mirrors the request-signing and canonicalization rules in core.js:
//   X-Sig = Ed25519( METHOD \n path+query \n ts \n nonce \n sha256hex(body) )
// Also used by vendors to sign webhook responses (see vendor-kit.js).
const crypto = require('crypto');

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : (v && typeof v === 'object') ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v);
const pubFromSpki = pub => crypto.createPublicKey({ key: unb64u(pub), format: 'der', type: 'spki' });

class Identity {
  constructor(privateKey) {
    if (privateKey) { this.privateKey = privateKey; this.publicKey = crypto.createPublicKey(privateKey); }
    else ({ privateKey: this.privateKey, publicKey: this.publicKey } = crypto.generateKeyPairSync('ed25519'));
    this.pub = b64u(this.publicKey.export({ format: 'der', type: 'spki' }));
  }
  sign(message) { return b64u(crypto.sign(null, Buffer.from(message), this.privateKey)); }
  /** PKCS#8 private key, base64url — paste into the storefront's "My own endpoint" to act as this vendor. */
  exportPkcs8() { return b64u(this.privateKey.export({ format: 'der', type: 'pkcs8' })); }
  static fromPkcs8(b64) { return new Identity(crypto.createPrivateKey({ key: unb64u(b64), format: 'der', type: 'pkcs8' })); }
}

/** Synchronous Ed25519 verify of a base64url signature over a UTF-8 message. */
function verify(message, sig, pub) {
  try { return crypto.verify(null, Buffer.from(message), pubFromSpki(pub), unb64u(sig)); } catch { return false; }
}
/** Verify a marketplace-signed {body, sig, kid} document (quote, receipt) offline. */
const verifyDoc = (doc, marketPub) => !!doc && verify(canon(doc.body), doc.sig, marketPub);

/** Signed API call. `over` lets tests pin {ts, nonce} to exercise replay/staleness checks. */
async function call(base, id, method, path, body, mandateId, over = {}) {
  const raw = body == null || method === 'GET' ? '' : JSON.stringify(body);
  const ts = over.ts || Date.now(), nonce = over.nonce || crypto.randomBytes(12).toString('hex');
  const headers = { 'content-type': 'application/json', 'x-key': id.pub, 'x-ts': String(ts), 'x-nonce': nonce,
    'x-sig': id.sign([method, path, ts, nonce, sha(raw)].join('\n')) };
  if (mandateId) headers['x-mandate'] = mandateId;
  const res = await fetch(base + path, { method, headers, body: raw || undefined });
  let out; try { out = await res.json(); } catch { out = null; }
  return { status: res.status, body: out };
}

/** A principal-signed spending mandate for an agent key. `funding` binds a PayPali grant. */
function makeMandate(human, agent, f) {
  const body = { mid: 'm_' + crypto.randomBytes(8).toString('hex'), principal_pub: human.pub, agent_pub: agent.pub,
    budget: f.budget, cap: f.cap, min_tier: f.min_tier, categories: f.categories || ['*'], exp: f.exp || Date.now() + 36e5 };
  if (f.funding) body.funding = f.funding;
  return { body, sig: human.sign(canon(body)) };
}

/** A signed third-party document {body, sig}: identity credentials, measurements, reproduction reports, audits. */
const signDoc = (id, body) => ({ body, sig: id.sign(canon(body)) });
/** Proof that the holder of `next` agrees to replace `current` (kind: 'principal' | 'vendor'). Signed by the NEW key. */
const rotationProof = (kind, current, next) => next.sign(`rotate-${kind}\n${current.pub}\n${next.pub}`);

module.exports = { Identity, call, makeMandate, verifyDoc, verify, canon, sha, b64u, unb64u, signDoc, rotationProof };
