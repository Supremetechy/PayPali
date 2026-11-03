'use strict';
// Vendor kit: a minimal, correct webhook endpoint for selling on the marketplace (Node, zero deps).
//
//   const { createVendorEndpoint } = require('./vendor-kit');
//   const ep = await createVendorEndpoint({ identity, marketBase: 'http://127.0.0.1:8787', handlers: {
//     'solution.invoke': async ({ solution_id, input }) => ({ output: { ...your result } }),
//     'order.purchased': async (data) => ({}),          // optional notifications
//     'outcome.attested': async (data) => ({}),
//   }});
//   // ep.url is your webhook_url; register it with POST /v1/vendors signed by `identity`.
//
// What it enforces for you:
//   * x-market-sig verified against the marketplace key from /.well-known/market-keys (kid-matched;
//     an unknown kid triggers one rate-limited refetch, so market key rotation needs no redeploy)
//   * timestamp within 5 minutes; event ids deduped — a retried id gets the SAME response bytes back
//   * every response is signed: x-vendor-sig = Ed25519(identity) over `${event_id}\n${sha256hex(body)}`
//   * endpoint.verify challenges are answered automatically
const http = require('http');
const { verify, sha } = require('./client');

async function fetchMarketKeys(marketBase) {
  const r = await fetch(marketBase.replace(/\/+$/, '') + '/.well-known/market-keys');
  const j = await r.json();
  return new Map(j.keys.map(k => [k.kid, k.public_key]));
}

async function createVendorEndpoint({ identity: initialIdentity, marketBase, marketKeys, resolveKey, handlers = {}, port = 0, host = '127.0.0.1', path = '/webhooks/market' }) {
  let identity = initialIdentity;
  let keys = marketKeys || await fetchMarketKeys(marketBase), lastFetch = 0;
  async function keyFor(kid) {
    if (keys.has(kid)) return keys.get(kid);
    if (resolveKey) { const k = await resolveKey(kid); if (k) keys.set(kid, k); return k; }
    if (marketBase && Date.now() - lastFetch > 30e3) { lastFetch = Date.now(); try { keys = await fetchMarketKeys(marketBase); } catch {} }
    return keys.get(kid);
  }
  const seen = new Map();          // event_id -> {status, body}
  const log = [];

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== path) { res.writeHead(404); return res.end(); }
    let raw = ''; req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      const reply = (status, obj, evId) => {
        const body = JSON.stringify(obj);
        const h = { 'content-type': 'application/json' };
        if (evId) h['x-vendor-sig'] = identity.sign(`${evId}\n${sha(body)}`);
        res.writeHead(status, h); res.end(body);
        return body;
      };
      const kid = req.headers['x-market-kid'], ts = +req.headers['x-market-ts'], evId = req.headers['x-market-event'], sig = req.headers['x-market-sig'];
      const pub = kid ? await keyFor(kid) : null;
      if (!pub || !evId || !sig || !ts) return reply(401, { error: 'missing_market_signature' });
      if (Math.abs(Date.now() - ts) > 5 * 60e3) return reply(401, { error: 'stale' });
      if (!verify(`${ts}\n${evId}\n${sha(raw)}`, sig, pub)) return reply(401, { error: 'bad_market_signature' });
      let ev; try { ev = JSON.parse(raw); } catch { return reply(400, { error: 'invalid_json' }); }
      if (ev.id !== evId) return reply(400, { error: 'event_id_mismatch' });

      const prior = seen.get(evId);
      if (prior) { res.writeHead(prior.status, { 'content-type': 'application/json', 'x-vendor-sig': identity.sign(`${evId}\n${sha(prior.body)}`) }); return res.end(prior.body); }

      let status = 200, out;
      try {
        if (ev.type === 'endpoint.verify') out = { challenge: ev.data.challenge };
        else if (handlers[ev.type]) out = (await handlers[ev.type](ev.data, ev)) || {};
        else out = { ignored: ev.type };
      } catch (e) { status = 500; out = { error: 'handler_failed' }; }
      const body = reply(status, out, evId);
      log.push({ id: evId, type: ev.type, at: Date.now(), data: ev.data, status, response: out });
      if (log.length > 200) log.splice(0, 50);
      if (status < 500) seen.set(evId, { status, body });   // only remember final answers; 5xx may be retried fresh
      if (seen.size > 10000) seen.delete(seen.keys().next().value);
    });
  });
  await new Promise(r => server.listen(port, host, r));
  return { server, url: `http://${host}:${server.address().port}${path}`, log, close: () => new Promise(r => server.close(r)),
    /** Key rotation: switch signing to the new identity, then call POST /v1/vendors/me/rotate (signed by the old key). */
    rotate: next => { identity = next; seen.clear(); } };
}

module.exports = { createVendorEndpoint, fetchMarketKeys };
