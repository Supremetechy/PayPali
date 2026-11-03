'use strict';
// HTTP wrapper around core.js. Also serves the storefront at "/" so the page talks to this API same-origin.
//
// Env:
//   PORT, MIN_OUTCOMES, DEMO=0 (disables /fund and the sandbox vendors)
//   ALLOW_INSECURE_WEBHOOKS=1   allow http:// + loopback vendor webhooks (defaults on when DEMO is on)
//   PAYPALI_URL, PAYPALI_MERCHANT_ID, PAYPALI_MERCHANT_SECRET   real money via PayPali Merchant Connect
//   REQUIRE_SELLER_AGENT=1   every vendor must name the PayPali agent it sells as (payout_agent_id + binding)
//   PAYPALI_PUBLIC_URL   where browsers reach PayPali (the storefront's Connect PayPali button); default PAYPALI_URL
//   Trust registries (JSON arrays of {id, public_key[, roles][, subject]}):
//     IDENTITY_ISSUERS   who may vouch "this principal key = one person/organisation"
//     VERIFIERS          who may sign measured real-world outcomes
//     AUDITORS           who may submit reproduction reports and audits (roles: reproduce, audit)
//   MIN_IDENTITY_ASSURANCE=dev|kyc (default kyc)    REQUIRE_VERIFIED_EVIDENCE=0|1 (default: on when issuers exist)
//   ADMIN_TOKEN        enables POST /v1/admin/rotate-market-key
//   STATE_FILE, STATE_KEY   persist everything (incl. market signing keys) to an AES-256-GCM encrypted file.
//                           STATE_KEY = 32 bytes as 64 hex chars. Saved every 5 s when changed and on shutdown.
//   RATE_LIMIT=0       disables rate limits       TRUST_PROXY=1   rate-limit by X-Forwarded-For
//   REQUIRE_VENDOR_IDENTITY=0|1   vendors need a live identity credential (default: on when issuers exist)
// Webhook egress: unless ALLOW_INSECURE_WEBHOOKS=1, vendor webhooks go through safe-fetch.js (resolve once, refuse private
// and reserved addresses, connect to the pinned address): DNS rebinding cannot reach internal hosts.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const Core = require('./core');
const { createPayPaliPayments } = require('./paypali');
const { createVendorEndpoint } = require('./vendor-kit');
const { Identity } = require('./client');
const { createSafeFetch } = require('./safe-fetch');

// DEMO-only sandbox vendor endpoints for the storefront's Sell tab. A browser cannot receive webhooks, so the
// server hosts a vendor-kit endpoint with a throwaway key and hands that key to the page: both sides then sign
// as the same vendor. Never enabled with DEMO=0, capped, and the keys are worthless outside this process.
function sandboxHost(mp) {
  const boxes = new Map();
  const invoke = async d => ({ output: { sandbox: true, solution_id: d.solution_id, run_id: d.run_id, received_fields: Object.keys(d.input || {}),
    result: 'ok', note: 'Sample answer from the dev sandbox endpoint. Point your listing at your own endpoint (vendor-kit.js) for real results.' } });
  const resolveKey = async kid => (mp.marketKeys().find(k => k.kid === kid) || {}).pub;
  return async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'POST' && req.url === '/dev/sandbox-vendors') {
      if (boxes.size >= 50) return send(429, { error: 'sandbox_limit' });
      const identity = new Identity();
      const ep = await createVendorEndpoint({ identity, marketKeys: new Map(), resolveKey, handlers: { 'solution.invoke': invoke } });
      const id = 'sbx_' + crypto.randomBytes(6).toString('hex');
      boxes.set(id, ep);
      return send(200, { id, url: ep.url, pkcs8: identity.exportPkcs8(), pub: identity.pub });
    }
    const m = req.method === 'GET' && req.url.match(/^\/dev\/sandbox-vendors\/(sbx_[0-9a-f]+)\/log$/);
    if (m) { const ep = boxes.get(m[1]); return ep ? send(200, { events: ep.log.slice(-50).reverse() }) : send(404, { error: 'not_found' }); }
    return false;
  };
}

function paymentsFromEnv() {
  const { PAYPALI_URL, PAYPALI_MERCHANT_ID, PAYPALI_MERCHANT_SECRET } = process.env;
  if (!PAYPALI_URL) return null;
  return createPayPaliPayments({ baseUrl: PAYPALI_URL, merchantId: PAYPALI_MERCHANT_ID || 'agentbazaar', secret: PAYPALI_MERCHANT_SECRET });
}
const jsonEnv = name => { const v = process.env[name]; if (!v) return undefined; try { return JSON.parse(v); } catch { throw new Error(name + ' must be a JSON array'); } };

// ---- Encrypted state file (AES-256-GCM, random IV, written atomically) ----
function stateStore(file, keyHex) {
  if (!file) return null;
  if (!/^[0-9a-f]{64}$/i.test(keyHex || '')) throw new Error('STATE_FILE needs STATE_KEY = 64 hex chars (32 bytes)');
  const key = Buffer.from(keyHex, 'hex');
  return {
    load() {
      if (!fs.existsSync(file)) return null;
      const buf = fs.readFileSync(file), iv = buf.subarray(0, 12), tag = buf.subarray(12, 28);
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
      return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
    },
    save(obj) {
      const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
      const tmp = file + '.tmp'; fs.writeFileSync(tmp, Buffer.concat([iv, c.getAuthTag(), ct]), { mode: 0o600 }); fs.renameSync(tmp, file);
    },
  };
}

async function start(port = 0, opts = {}) {
  const demo = process.env.DEMO !== '0';
  const store = opts.store !== undefined ? opts.store : stateStore(process.env.STATE_FILE, process.env.STATE_KEY);
  const state = store ? store.load() : null;
  const insecure = process.env.ALLOW_INSECURE_WEBHOOKS ? process.env.ALLOW_INSECURE_WEBHOOKS === '1' : demo;
  const env = {
    fetch: insecure ? undefined : createSafeFetch(),
    minOutcomes: +process.env.MIN_OUTCOMES || undefined, demo,
    allowInsecureWebhooks: insecure,
    ...(process.env.REQUIRE_VENDOR_IDENTITY ? { requireVendorIdentity: process.env.REQUIRE_VENDOR_IDENTITY === '1' } : {}),
    payments: opts.payments === undefined ? paymentsFromEnv() : opts.payments,
    identityIssuers: jsonEnv('IDENTITY_ISSUERS'), verifiers: jsonEnv('VERIFIERS'), auditors: jsonEnv('AUDITORS'),
    paypaliPublicUrl: process.env.PAYPALI_PUBLIC_URL || process.env.PAYPALI_URL || undefined,
    ...(process.env.REQUIRE_SELLER_AGENT ? { requireSellerAgent: process.env.REQUIRE_SELLER_AGENT === '1' } : {}),
    minAssurance: process.env.MIN_IDENTITY_ASSURANCE || undefined, adminToken: process.env.ADMIN_TOKEN || undefined,
    ...(process.env.REQUIRE_VERIFIED_EVIDENCE ? { requireVerifiedEvidence: process.env.REQUIRE_VERIFIED_EVIDENCE === '1' } : {}),
    ...(process.env.RATE_LIMIT === '0' ? { rateLimit: false } : {}),
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const mp = await Core.createMarketplace({ ...env, ...opts, state });
  const sandbox = demo ? sandboxHost(mp) : null;
  const trustProxy = process.env.TRUST_PROXY === '1';
  let dirty = false;
  const srv = http.createServer(async (req, res) => {
    if (sandbox && req.url.startsWith('/dev/sandbox-vendors') && (await sandbox(req, res)) !== false) return;
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const f = path.join(__dirname, 'storefront.html');
      if (fs.existsSync(f)) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(f)); }
    }
    let raw = ''; req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      const ip = (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
      const out = await mp.handle({ method: req.method, url: req.url, headers: req.headers, raw, ip });
      if (req.method !== 'GET') dirty = true;
      const h = { 'content-type': 'application/json' };
      if (out.status === 429 && out.body.retry_after_ms) h['retry-after'] = String(Math.ceil(out.body.retry_after_ms / 1000));
      res.writeHead(out.status, h); res.end(JSON.stringify(out.body));
    });
  });
  // Drive the outbox (vendor events, vendor payouts, outcome reports and refunds to PayPali).
  let ticking = false;
  const timer = setInterval(async () => { if (ticking) return; ticking = true; try { if (await mp.tick()) dirty = true; } finally { ticking = false; } }, opts.tickMs || 1000);
  const persist = async () => { if (!store || !dirty) return; dirty = false; try { store.save(await mp.exportState()); } catch (e) { dirty = true; console.error('state save failed:', e.message); } };
  const saver = store ? setInterval(persist, 5000) : null;
  srv.on('close', () => { clearInterval(timer); if (saver) clearInterval(saver); });
  return new Promise(r => srv.listen(port, () => r({ server: srv, mp, persist, url: 'http://127.0.0.1:' + srv.address().port, marketPub: mp.publicKey, restored: !!state })));
}
module.exports = { start, stateStore };
if (require.main === module) start(+process.env.PORT || 8787).then(({ url, persist, restored }) => {
  console.log('Solutions Farm API + storefront on ' + url + (process.env.PAYPALI_URL ? '  · payments: PayPali ' + process.env.PAYPALI_URL : '  · payments: simulated credits')
    + (process.env.STATE_FILE ? `  · state: ${process.env.STATE_FILE}${restored ? ' (restored)' : ''}` : ''));
  const bye = async () => { await persist(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
});
