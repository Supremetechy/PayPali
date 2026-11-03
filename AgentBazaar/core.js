// Solutions Farm marketplace core. Runs unchanged in Node (>=20) and in browsers with WebCrypto Ed25519.
// Pure logic: handle({method,url,headers,raw,ip}) -> {status, body}. server.js wraps it in HTTP; the storefront inlines it.
(function (root) {
'use strict';
const enc = new TextEncoder();
const subtle = root.crypto.subtle;
const b64u = u8 => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await subtle.digest('SHA-256', enc.encode(s)));
const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : (v && typeof v === 'object') ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v);
const rnd = n => hex(root.crypto.getRandomValues(new Uint8Array(n)));
const E = (code, msg, extra) => Object.assign(new Error(msg), { code, extra });
const now = () => Date.now();
const idOf = async (p, k) => p + '_' + (await sha(k)).slice(0, 16);
const kc = new Map();
const imp = async k => { let c = kc.get(k); if (!c) { c = await subtle.importKey('spki', unb64u(k), { name: 'Ed25519' }, false, ['verify']); if (kc.size > 2000) kc.clear(); kc.set(k, c); } return c; };
const verify = async (m, s, k) => { try { return await subtle.verify({ name: 'Ed25519' }, await imp(k), unb64u(s), enc.encode(m)); } catch { return false; } };
const verifyDoc = (doc, marketPub) => verify(canon(doc.body), doc.sig, marketPub);   // receipts and quotes, offline

function wilson(k, n, z = 1.645) {
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}

// ---------------------------------------------------------------------------
// JSON Schema subset for listing input/output contracts (no regex: no ReDoS).
// type, enum, const, properties, required, additionalProperties, items,
// minimum, maximum, minLength, maxLength, minItems, maxItems, description, title.
// ---------------------------------------------------------------------------
const SCHEMA_KEYS = new Set(['type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'description', 'title']);
const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
function checkSchemaShape(s, depth = 0) {
  if (depth > 10) return 'too_deep';
  if (typeof s !== 'object' || s === null || Array.isArray(s)) return 'not_an_object';
  for (const k of Object.keys(s)) if (!SCHEMA_KEYS.has(k)) return 'unsupported_keyword:' + k;
  const ts = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
  if (ts.some(t => !TYPES.includes(t))) return 'bad_type';
  if (s.properties) { if (typeof s.properties !== 'object') return 'bad_properties'; for (const v of Object.values(s.properties)) { const e = checkSchemaShape(v, depth + 1); if (e) return e; } }
  if (s.items) { const e = checkSchemaShape(s.items, depth + 1); if (e) return e; }
  if (s.additionalProperties && typeof s.additionalProperties === 'object') { const e = checkSchemaShape(s.additionalProperties, depth + 1); if (e) return e; }
  if (s.required && !(Array.isArray(s.required) && s.required.every(x => typeof x === 'string'))) return 'bad_required';
  return null;
}
function validate(s, v, path = '$', errs = []) {
  if (errs.length > 20) return errs;
  const typeOf = x => x === null ? 'null' : Array.isArray(x) ? 'array' : Number.isInteger(x) ? 'integer' : typeof x;
  if (s.type !== undefined) {
    const ts = Array.isArray(s.type) ? s.type : [s.type], t = typeOf(v);
    if (!ts.some(x => x === t || (x === 'number' && t === 'integer'))) { errs.push(`${path}: expected ${ts.join('|')}, got ${t}`); return errs; }
  }
  if (s.const !== undefined && canon(v) !== canon(s.const)) errs.push(`${path}: must equal ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.some(e => canon(e) === canon(v))) errs.push(`${path}: not one of the allowed values`);
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) errs.push(`${path}: below minimum ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) errs.push(`${path}: above maximum ${s.maximum}`);
  }
  if (typeof v === 'string') {
    if (s.minLength !== undefined && v.length < s.minLength) errs.push(`${path}: shorter than ${s.minLength}`);
    if (s.maxLength !== undefined && v.length > s.maxLength) errs.push(`${path}: longer than ${s.maxLength}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) errs.push(`${path}: fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && v.length > s.maxItems) errs.push(`${path}: more than ${s.maxItems} items`);
    if (s.items) v.forEach((x, i) => validate(s.items, x, `${path}[${i}]`, errs));
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const r of s.required || []) if (!(r in v)) errs.push(`${path}.${r}: required`);
    for (const [k, x] of Object.entries(v)) {
      if (s.properties && s.properties[k]) validate(s.properties[k], x, `${path}.${k}`, errs);
      else if (s.additionalProperties === false) errs.push(`${path}.${k}: not allowed`);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') validate(s.additionalProperties, x, `${path}.${k}`, errs);
    }
  }
  return errs;
}

const ASSURANCE = { dev: 1, kyc: 2 };   // identity assurance levels, weakest first

async function createMarketplace(opts = {}) {
  const MIN_N = opts.minOutcomes || 12, DEMO = opts.demo !== false, TOL = 0.05, SLACK = 0.25, FEE = 0.10;
  const FETCH = opts.fetch || (root.fetch && root.fetch.bind(root));
  const INSECURE = !!opts.allowInsecureWebhooks;          // permit http:// and loopback/private hosts (local dev only)
  const HOOK_TIMEOUT = opts.webhookTimeoutMs || 8000, MAX_OUT = 256 * 1024;
  const PAY = opts.payments || null;                      // PayPali adapter (paypali.js)
  const now0 = Date.now;

  // ---- Trust registries (gap 1, 5) -------------------------------------------------------------
  // Identity issuers vouch that a principal key belongs to ONE real human or organisation (subject).
  // Verifiers measure a run's real-world result. Auditors reproduce and audit listings.
  const ISSUERS = new Map((opts.identityIssuers || []).map(i => [i.id, i]));
  const MIN_ASSURANCE = ASSURANCE[opts.minAssurance || 'kyc'] || ASSURANCE.kyc;
  const REQUIRE_VERIFIED = opts.requireVerifiedEvidence ?? ISSUERS.size > 0;
  // Vendors must hold a live identity credential (and payouts need an issuer-signed binding) whenever issuers exist.
  const REQUIRE_VENDOR_ID = opts.requireVendorIdentity ?? ISSUERS.size > 0;
  const TFETCH = opts.trustFetch || (root.fetch && root.fetch.bind(root));   // for configured issuer URLs (revocation feeds), not vendor URLs
  let revFetchAt = 0;
  const VERIFIERS = new Map((opts.verifiers || []).map(v => [v.id, v]));
  const AUDITORS = new Map((opts.auditors || []).map(a => [a.id, { roles: ['reproduce', 'audit'], ...a }]));
  const MAX_PER_SUBJECT = opts.maxOutcomesPerIdentity || 4;  // no single identity can carry a tier
  const OBS_TOL = 0.10;                                      // human vs agent observed: 10% relative tolerance
  const REPRO_TOL = 0.10;
  const REFUND_AFTER = opts.refundAfterMs ?? 24 * 3600e3;
  const RATE = opts.rateLimit === false ? null : { capacity: 120, refillPerSec: 2, ipCapacity: 600, ipRefillPerSec: 20, ...(opts.rateLimit || {}) };

  // ---- Market signing keys (rotatable; retired keys stay published for verification) ----------
  const K = [];   // [{kid, pub, priv(CryptoKey), status, created}]
  async function addKey(pkcs8, meta = {}) {
    let priv, pub;
    if (pkcs8) {
      priv = await subtle.importKey('pkcs8', unb64u(pkcs8), { name: 'Ed25519' }, true, ['sign']);
      pub = meta.pub;
    } else {
      const kp = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
      priv = kp.privateKey; pub = b64u(new Uint8Array(await subtle.exportKey('spki', kp.publicKey)));
    }
    const k = { kid: meta.kid || 'mk_' + (await sha(pub)).slice(0, 8), pub, priv, status: meta.status || 'active', created: meta.created || now() };
    K.push(k); return k;
  }
  const active = () => K.find(k => k.status === 'active');
  const st = opts.state || null;
  if (st && st.market_keys && st.market_keys.length) for (const k of st.market_keys) await addKey(k.pkcs8, k);
  else await addKey();
  const sign = async body => { const k = active(); return { body, sig: b64u(new Uint8Array(await subtle.sign({ name: 'Ed25519' }, k.priv, enc.encode(canon(body))))), kid: k.kid }; };
  const signRaw = async str => b64u(new Uint8Array(await subtle.sign({ name: 'Ed25519' }, active().priv, enc.encode(str))));

  const S = { byKey: new Map(), principals: new Map(), mandates: new Map(), quotes: new Map(), receipts: new Map(), runs: new Map(), nonces: new Map(), vendorEarnings: new Map(),
    vendors: new Map(), vendorByKey: new Map(), deliveries: [], outbox: [], seenEvents: new Set(), subjects: new Map(), vendorSubjects: new Map(), buckets: new Map(), revoked: new Set() };

  // Demo helpers for the seeded discovery and travel listings (deterministic, simulated data).
  const hashN = (str, mod) => { let h = 2166136261; for (const c of String(str)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h % mod; };
  function locateBots(capability, n, verifiedOnly) {
    const names = ['LedgerLoop', 'ReconBot', 'InvoiceHawk', 'Tallyhand', 'BooksBuddy', 'MatchMate', 'ClearDesk', 'SumCheck'];
    return names.slice(0, n).map((name, k) => ({
      name, capability, endpoint: `https://${name.toLowerCase()}.example/mcp`, protocol: k % 3 ? 'mcp' : 'http',
      price_per_call_gas: 5 + hashN(name + capability, 40), verified: verifiedOnly ? k < 4 : k === 0,
      trust: verifiedOnly ? (k < 4 ? 'identity verified + attested outcomes' : 'listed, unverified') : (k === 0 ? 'self-declared' : 'unknown'),
    }));
  }
  function findTrip(i, sources, staleDiscount) {
    const route = `${i.origin || 'JFK'}-${i.destination || 'LAX'}`, nights = Math.max(1, Math.min(14, i.nights || 3));
    const quotes = sources.map(src => {
      const flight = 180 + hashN(route + src + 'f', 220), hotel = (95 + hashN(route + src + 'h', 120)) * nights;
      return { source: src, flight_usd: flight, hotel_usd: hotel, total_usd: flight + hotel };
    }).sort((a, b) => a.total_usd - b.total_usd);
    const all = ['ota_a', 'ota_b', 'ota_c', 'airline_direct', 'hotel_direct'].map(src => 180 + hashN(route + src + 'f', 220) + (95 + hashN(route + src + 'h', 120)) * nights).sort((a, b) => a - b);
    const median = all[2], best = quotes[0];
    const total = Math.round(best.total_usd * (1 - staleDiscount));
    return { route, depart: i.depart || '2026-12-12', nights, best: { ...best, total_usd: total }, compared: quotes.length, saving_vs_median: median - total, simulated: true };
  }

  // Seeded catalog. V2/V3 here are SEED data (basis "seed"), shown as such; vendor listings earn tiers from signed reports.
  const SEED = [
    { id: 'sf-0152', name: 'Brokerage Fee & Drag Auditor', category: 'Finance', price: 28, tier: 3, claim: 0.87, vendor_principal: 'prn_vendor_plainview', blurb: 'Reads holdings, surfaces expense drag, ranks cheaper equivalents.',
      run: i => { const h = i.holdings || []; return { annual_fee_drag: +h.reduce((a, x) => a + x.value * x.expense_ratio, 0).toFixed(2), positions: h.length }; } },
    { id: 'sf-0233', name: 'Grid Load Shift Scheduler', category: 'Energy', price: 34, tier: 3, claim: 0.93, vendor_principal: 'prn_vendor_wattloom', blurb: 'Moves heavy loads and EV charging into cheaper tariff windows.',
      run: i => ({ start_hour: 2, est_saving_pct: 18, appliance: i.appliance || 'ev_charger' }) },
    { id: 'sf-0170', name: 'Idle Cash Yield Router', category: 'Finance', price: 19, tier: 2, claim: 0.82, vendor_principal: 'prn_vendor_sweepline', blurb: 'Moves uncommitted cash to the best insured yield.',
      outcome_metric: { name: 'annual_gain', unit: 'USD', direction: 'higher', success_threshold: 0.01 },
      run: i => ({ annual_gain: +((i.cash || 0) * ((i.apy_best || 0) - (i.apy_now || 0))).toFixed(2) }) },
    { id: 'sf-0163', name: 'Rebalance Rule Backtest Pack', category: 'Finance', price: 55, tier: 3, claim: 0.78, vendor_principal: 'prn_vendor_quantfield', blurb: '20-year walk-forward test of rebalancing rules.',
      run: i => ({ rule: 'threshold_5pct', echo: i }) },
    { id: 'sf-0188', name: 'Speculative Signal Bundle', category: 'Finance', price: 12, tier: 1, claim: 0.64, vendor_principal: 'prn_vendor_alpharush', blurb: 'Momentum signals with bold claims. Unverified.',
      run: () => ({ signal: 'unverified' }) },
    { id: 'sf-0201', name: 'Contract Clause Risk Checker', category: 'Legal', price: 48, tier: 3, claim: 0.89, vendor_principal: 'prn_vendor_clauseworks', blurb: 'Flags auto-renewals, liability caps and odd indemnities before signing.',
      run: () => ({ flagged: ['auto_renewal_90d', 'uncapped_indemnity'] }) },
    { id: 'sf-0257', name: 'Supplier Negotiation Playbook', category: 'Operations', price: 39, tier: 2, claim: 0.74, vendor_principal: 'prn_vendor_haggle', blurb: 'Counteroffer ranges an agent can run with procurement contacts.',
      run: () => ({ counter_range_pct: [4, 9] }) },
    { id: 'sf-0271', name: 'Warranty Claim Filer', category: 'Consumer', price: 15, tier: 2, claim: 0.81, vendor_principal: 'prn_vendor_fixwell', blurb: 'Gathers receipts and serials and files with the right portal.',
      run: () => ({ filed: true }) },
    // Same function, three sellers, three trust levels: what an agent should buy is the verified one, not the cheapest.
    { id: 'sf-0310', function: 'agent_locator', seller: 'BotRadar', name: 'BotRadar Agent Locator', category: 'Agent discovery', price: 22, tier: 3, claim: 0.91, vendor_principal: 'prn_vendor_botradar',
      blurb: 'Finds every online agent/bot that offers a capability, with endpoints, pricing and verification status. Lab-reproduced.',
      run: i => ({ capability: i.capability || 'invoice_reconciliation', found: locateBots(i.capability || 'invoice_reconciliation', 5, true), checked_sources: 9 }) },
    { id: 'sf-0311', function: 'agent_locator', seller: 'CrawlScout', name: 'CrawlScout Bot Index', category: 'Agent discovery', price: 14, tier: 2, claim: 0.84, vendor_principal: 'prn_vendor_crawlscout',
      blurb: 'Crawls public agent directories and MCP registries for bots offering a capability. Track record from attested outcomes.',
      run: i => ({ capability: i.capability || 'invoice_reconciliation', found: locateBots(i.capability || 'invoice_reconciliation', 4, false), checked_sources: 4 }) },
    { id: 'sf-0312', function: 'agent_locator', seller: 'OmniBot', name: 'OmniBot Finder 9000', category: 'Agent discovery', price: 6, tier: 1, claim: 0.97, vendor_principal: 'prn_vendor_omnibot',
      blurb: 'Finds ALL the bots, instantly. 97% accuracy guaranteed. Unverified claims.',
      run: i => ({ capability: i.capability || 'invoice_reconciliation', found: locateBots(i.capability || 'invoice_reconciliation', 7, false).map((b, k) => (k % 2 ? { ...b, endpoint: null, note: 'dead link' } : b)), checked_sources: 1 }) },
    // Price finders: same request, three sellers. Fares are simulated for the demo.
    { id: 'sf-0320', function: 'travel_price_finder', seller: 'FareWise', name: 'FareWise Flight + Hotel Finder', category: 'Travel', price: 18, tier: 3, claim: 0.9, vendor_principal: 'prn_vendor_farewise',
      blurb: 'Searches online-travel-agency, airline and hotel sources for a trip and returns the cheapest bookable flight + hotel total.',
      outcome_metric: { name: 'saving_vs_median', unit: 'USD', direction: 'higher', success_threshold: 1 },
      run: i => findTrip(i, ['ota_a', 'ota_b', 'ota_c', 'airline_direct', 'hotel_direct'], 0) },
    { id: 'sf-0321', function: 'travel_price_finder', seller: 'TripTally', name: 'TripTally Price Scout', category: 'Travel', price: 11, tier: 2, claim: 0.83, vendor_principal: 'prn_vendor_triptally',
      blurb: 'Compares two online travel agencies for flight + hotel bundles.',
      outcome_metric: { name: 'saving_vs_median', unit: 'USD', direction: 'higher', success_threshold: 1 },
      run: i => findTrip(i, ['ota_a', 'ota_b'], 0) },
    { id: 'sf-0322', function: 'travel_price_finder', seller: 'CheapJet', name: 'CheapJet Deal Blaster', category: 'Travel', price: 5, tier: 1, claim: 0.95, vendor_principal: 'prn_vendor_cheapjet',
      blurb: 'Lowest fares on the internet, every time! Unverified claims.',
      outcome_metric: { name: 'saving_vs_median', unit: 'USD', direction: 'higher', success_threshold: 1 },
      run: i => ({ ...findTrip(i, ['ota_c'], 0.35), warning: 'fare not bookable at checkout (stale cache)' }) },
  ].map(s => ({ runs_included: 4, outcomes: [], history: [], fulfillment: 'builtin', status: 'active', vendor_id: null, basis: 'seed', seed_tier: s.tier,
    reproductions: [], audits: [], non_deliveries: 0, ...s, price_minor: Math.round(s.price * 100) }));
  const runFns = new Map(SEED.map(s => [s.id, s.run]));
  let catalog = SEED;
  const find = id => catalog.find(s => s.id === id);

  // ---------------------------------------------------------------------------
  // Evidence (gap 1 + 6). Counted toward tiers:
  //   * measured outcomes (a registered verifier signed the real result) — always, and they win over the human;
  //   * human-attested outcomes — only from principals holding a valid identity credential when
  //     identity issuers are configured (REQUIRE_VERIFIED), never from the vendor's own identity;
  //   * at most MAX_PER_SUBJECT outcomes per identity (or principal, when unverified evidence is allowed);
  //   * each weighted by min(1, price paid / current price): evidence bought cheap counts less, so
  //     listing at $0.01, farming confirmations, then raising the price buys nothing.
  // A listing with a verifier counts ONLY measured outcomes.
  // ---------------------------------------------------------------------------
  function evidence(s) {
    const vendorSubjects = s.vendor_id ? subjectsOfVendor(S.vendors.get(s.vendor_id)) : [];
    const per = {}, counted = [];
    let revoked = 0, unverified = 0, capped = 0, vendor_excluded = 0, measured = 0, mismatches = 0, disagreements = 0, attested = 0;
    for (const o of s.outcomes) {
      if (o.attested) attested++;
      if (o.observation_mismatch) mismatches++;
      if (o.measurement && o.attested && o.success !== o.measurement.success) disagreements++;
      const isMeasured = !!o.measurement;
      if (isMeasured) measured++;
      if (!isMeasured && (!o.attested || s.verifier_id)) continue;
      if (!isMeasured && o.subject && S.revoked.has(o.subject)) { revoked++; continue; }   // retroactive: a revoked identity's evidence stops counting
      if (!isMeasured && REQUIRE_VERIFIED && !o.subject) { unverified++; continue; }
      if (o.subject && vendorSubjects.includes(o.subject)) { vendor_excluded++; continue; }
      const who = o.subject || o.principal;
      if ((per[who] || 0) >= MAX_PER_SUBJECT) { capped++; continue; }
      per[who] = (per[who] || 0) + 1;
      const w = Math.min(1, (o.paid_minor ?? s.price_minor) / s.price_minor);
      counted.push({ who, w, success: isMeasured ? o.measurement.success : o.success });
    }
    const n = counted.reduce((a, x) => a + x.w, 0), k = counted.reduce((a, x) => a + (x.success ? x.w : 0), 0);
    const wBy = {}; counted.forEach(x => wBy[x.who] = (wBy[x.who] || 0) + x.w);
    const [lo, hi] = n ? wilson(k, n) : [0, 1];
    return { n: +n.toFixed(2), counted: counted.length, successes: +k.toFixed(2), rate: n ? +(k / n).toFixed(3) : null,
      distinct_principals: Object.keys(wBy).length, max_principal_share: n ? +(Math.max(...Object.values(wBy)) / n).toFixed(2) : 0,
      ci_low: +lo.toFixed(3), ci_high: +hi.toFixed(3), attested, provisional: s.outcomes.filter(o => !o.attested && !o.measurement).length,
      disputed: s.outcomes.filter(o => o.attested && o.agent_success !== null && o.agent_success !== o.success).length,
      unverified_excluded: unverified, revoked_excluded: revoked, capped, vendor_excluded, measured, observation_mismatches: mismatches, measurement_disagreements: disagreements,
      non_deliveries: s.non_deliveries || 0, needed: MIN_N, verified_evidence_required: REQUIRE_VERIFIED };
  }
  const stats = evidence;

  // ---------------------------------------------------------------------------
  // Tiers (gap 5). Vendor listings: V1 by default; V2 = a passing reproduction by a registered auditor;
  // V3 = plus a passing audit by a DIFFERENT auditor; both bound to the current listing hash (what is
  // actually sold: endpoint, schemas, metric, claim, runs, verifier). Change any of it and they lapse.
  // V4 = V3 + outcome evidence (above). Seed listings keep their seeded V2/V3 (basis "seed").
  // ---------------------------------------------------------------------------
  async function listingHash(s) {
    if (s.basis === 'seed') return null;
    const v = S.vendors.get(s.vendor_id) || {};
    return sha(canon({ id: s.id, vendor_id: s.vendor_id, endpoint: v.webhook_url || null, input_schema: s.input_schema || null, output_schema: s.output_schema || null,
      outcome_metric: s.outcome_metric || null, claim: s.claim, runs_included: s.runs_included, verifier_id: s.verifier_id || null }));
  }
  async function staticTier(s) {
    if (s.basis === 'seed') return { tier: s.seed_tier, basis: 'seed data, not independently verified' };
    const h = await listingHash(s);
    const reps = s.reproductions.filter(r => r.listing_hash === h && r.pass);
    const aud = s.audits.find(a => a.listing_hash === h && a.pass && reps.some(r => r.auditor !== a.auditor));
    if (aud) return { tier: 3, basis: `audited by ${aud.auditor}, reproduced by ${reps.find(r => r.auditor !== aud.auditor).auditor}` };
    if (reps.length) return { tier: 2, basis: `reproduced by ${reps[0].auditor}` };
    return { tier: 1, basis: 'claimed' };
  }
  async function reeval(s) {
    const base = await staticTier(s), ev = evidence(s);
    let t = base.tier, basis = base.basis;
    if (base.tier === 3) {
      const promote = ev.n >= MIN_N && ev.distinct_principals >= 3 && ev.max_principal_share <= 0.5 && ev.rate >= s.claim - TOL && ev.ci_low >= s.claim - SLACK;
      const demote = ev.n >= MIN_N && ev.ci_high < s.claim - TOL;
      if (promote || (s.tier === 4 && !demote)) { t = 4; basis = `${base.basis}; outcome-proven (${ev.n} weighted outcomes)`; }
    }
    s.basis_text = basis;
    if (t !== s.tier) { s.history.push({ from: s.tier, to: t, at: now(), basis, evidence: ev }); s.tier = t; }
    return t;
  }
  async function reevalVendor(vendorId) { for (const s of catalog) if (s.vendor_id === vendorId) await reeval(s); }

  const listing = s => ({ id: s.id, name: s.name, category: s.category, price: s.price, price_minor: s.price_minor, currency: 'USD', blurb: s.blurb, claimed_success: s.claim,
    runs_included: s.runs_included, status: s.status, fulfillment: s.fulfillment, input_schema: s.input_schema || null, output_schema: s.output_schema || null,
    outcome_metric: s.outcome_metric || null, verifier_id: s.verifier_id || null, function: s.function || null, seller: s.seller || null,
    vendor: s.vendor_id ? { id: s.vendor_id, display_name: S.vendors.get(s.vendor_id).display_name, identity_verified: vendorLive(S.vendors.get(s.vendor_id)),
      // The seller is a PayPali agent when its payout binding names one (the agent that is paid for each sale).
      agent_id: S.vendors.get(s.vendor_id).payout_binding ? S.vendors.get(s.vendor_id).payout_agent_id : null } : null,
    verification: { tier: s.tier, basis: s.basis_text || 'claimed', seed: s.basis === 'seed', ...stats(s),
      reproductions: s.reproductions.map(r => ({ auditor: r.auditor, runs: r.runs, passed: r.passed, pass: r.pass, at: r.at, current: r.listing_hash === s._hash })),
      audits: s.audits.map(a => ({ auditor: a.auditor, pass: a.pass, at: a.at, current: a.listing_hash === s._hash })) },
    listing_hash: s._hash || null, tier_history: s.history });
  async function refreshHash(s) { s._hash = await listingHash(s); }

  // ---- Rate limits (gap 4): token bucket per key (signed calls) and per client IP ----
  function limit(id, cost = 1) {
    if (!RATE || !id) return;
    const ip = id.startsWith('ip:'), cap = ip ? RATE.ipCapacity : RATE.capacity, rate = ip ? RATE.ipRefillPerSec : RATE.refillPerSec;
    const t = now(); let b = S.buckets.get(id);
    if (!b) { b = { tokens: cap, at: t }; S.buckets.set(id, b); if (S.buckets.size > 50000) S.buckets.clear(); }
    b.tokens = Math.min(cap, b.tokens + (t - b.at) / 1000 * rate); b.at = t;
    if (b.tokens < cost) throw E(429, 'rate_limited', { retry_after_ms: Math.ceil((cost - b.tokens) / rate * 1000) });
    b.tokens -= cost;
  }

  async function auth(req) {
    const h = req.headers, key = h['x-key'], ts = +h['x-ts'], nonce = h['x-nonce'], sig = h['x-sig'];
    if (!key || !ts || !nonce || !sig) throw E(401, 'missing_auth_headers');
    if (Math.abs(now() - ts) > 60000) throw E(401, 'stale_timestamp');
    if (!(await verify([req.method, req.url, ts, nonce, await sha(req.raw)].join('\n'), sig, key))) throw E(401, 'bad_signature');
    if (S.nonces.has(key + nonce)) throw E(401, 'replayed_nonce');
    S.nonces.set(key + nonce, ts);
    for (const [k, t] of S.nonces) if (now() - t > 120000) S.nonces.delete(k);
    return key;
  }
  const principalOf = key => { const p = S.byKey.get(key); if (!p) throw E(403, 'unknown_principal'); return p; };
  function mctx(req, key) {
    const m = S.mandates.get(req.headers['x-mandate']);
    if (!m) throw E(403, 'unknown_mandate');
    if (m.mb.agent_pub !== key) throw E(403, 'agent_key_mismatch');
    if (m.revoked) throw E(403, 'mandate_revoked');
    if (m.mb.exp < now()) throw E(403, 'mandate_expired');
    return m;
  }
  function release(m) { if (m.funding || m.released || !(m.revoked || m.mb.exp < now())) return; m.released = true; S.principals.get(m.principal).balance += m.mb.budget - m.spent; }
  function denyReasons(m, s) {
    const r = [], mb = m.mb;
    if (s.price > mb.cap) r.push('over_per_purchase_cap');
    if (s.tier < mb.min_tier) r.push('below_min_verification_tier');
    if (!mb.categories.includes('*') && !mb.categories.includes(s.category)) r.push('category_not_allowed');
    if (s.price > mb.budget - m.spent) r.push('insufficient_mandate_budget');
    return r;
  }
  /** The identity subject a principal can currently contribute evidence with, or null. */
  function liveSubject(pr) {
    const id = pr && pr.identity;
    if (!id || id.exp < now() || (ASSURANCE[id.assurance] || 0) < MIN_ASSURANCE || S.revoked.has(id.issuer + ':' + id.subject)) return null;
    return id.issuer + ':' + id.subject;
  }
  /** Every subject a vendor has ever operated under (its own outcomes never count, even after re-verification). */
  const subjectsOfVendor = v => v ? [v.subject, ...(v.past_subjects || [])].filter(Boolean) : [];
  const vendorLive = v => !!v && !!liveSubject(S.principals.get(v.principal_id));
  const vendorSellable = v => !REQUIRE_VENDOR_ID || vendorLive(v);
  /** Why a vendor's payouts are held, or null. */
  function payoutHold(v) {
    if (!ISSUERS.size) return null;
    const pb = v && v.payout_binding;
    if (!pb) return 'payout_binding_missing';
    if (pb.body.exp < now()) return 'payout_binding_expired';
    if (pb.body.vendor_pub !== v.key) return 'payout_binding_for_old_vendor_key';
    if (S.revoked.has(pb.body.issuer + ':' + pb.body.subject)) return 'vendor_identity_revoked';
    if (liveSubject(S.principals.get(v.principal_id)) !== pb.body.issuer + ':' + pb.body.subject) return 'payout_binding_subject_changed';
    return null;
  }

  // ---- Issuer revocations: push (POST /v1/identity/revocations) and pull (issuer revocations_url) ----
  async function applyRevocation(doc) {
    const b = (doc && doc.body) || {}, iss = ISSUERS.get(b.issuer);
    if (!iss) throw E(403, 'unknown_identity_issuer');
    if (b.kind !== 'revocation' || typeof b.subject !== 'string' || !(await signedBy(doc, iss.public_key))) throw E(400, 'bad_revocation');
    const key = b.issuer + ':' + b.subject;
    if (S.revoked.has(key)) return { revoked: true, duplicate: true };
    S.revoked.add(key);
    const pid = S.subjects.get(key), pr = pid && S.principals.get(pid);
    if (pr) { pr.identity_revoked = { at: now(), reason: String(b.reason || '').slice(0, 120) }; pr.identity = null; }   // binding kept: the subject cannot move elsewhere
    const vid = S.vendorSubjects.get(key), vpr = vid && S.principals.get(vid);
    if (vpr) { vpr.identity_revoked = { at: now(), reason: String(b.reason || '').slice(0, 120) }; vpr.identity = null; }
    for (const s of catalog) await reeval(s);
    return { revoked: true, principal_unbound: !!pr };
  }
  async function pullRevocations(force) {
    if (!TFETCH || (!force && now() - revFetchAt < 60e3)) return 0;
    revFetchAt = now(); let n = 0;
    for (const i of ISSUERS.values()) {
      if (!i.revocations_url) continue;
      try {
        const r = await TFETCH(i.revocations_url, { redirect: 'manual' }), j = await r.json();
        for (const d of (j.revocations || []).slice(0, 5000)) { try { const x = await applyRevocation(d); if (!x.duplicate) n++; } catch {} }
      } catch {}
    }
    return n;
  }

  // ---------------------------------------------------------------------------
  // Vendor webhooks (signed both ways). See README "Vendor webhooks".
  // ---------------------------------------------------------------------------
  const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[?::1?\]?|\[?f[cd][0-9a-f]{2}:.*)$/i;
  function checkWebhookUrl(raw) {
    let u; try { u = new URL(raw); } catch { throw E(400, 'bad_webhook_url'); }
    if (u.username || u.password) throw E(400, 'bad_webhook_url');
    if (!INSECURE && (u.protocol !== 'https:' || PRIVATE_HOST.test(u.hostname))) throw E(400, 'webhook_url_must_be_public_https');
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw E(400, 'bad_webhook_url');
    return u.toString();
  }
  function logDelivery(d) { S.deliveries.push(d); if (S.deliveries.length > 2000) S.deliveries.splice(0, 500); }

  async function deliver(vendor, type, data, eventId) {
    if (!FETCH) return { ok: false, error: 'webhooks_unavailable', retryable: false };
    const ev = { id: eventId || 'evt_' + rnd(10), type, created_at: now(), data };
    const body = JSON.stringify(ev), ts = now(), t0 = now0();
    const headers = { 'content-type': 'application/json', 'x-market-kid': active().kid, 'x-market-ts': String(ts), 'x-market-event': ev.id,
      'x-market-sig': await signRaw(`${ts}\n${ev.id}\n${await sha(body)}`) };
    let out;
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), HOOK_TIMEOUT);
      let res, text;
      try { res = await FETCH(vendor.webhook_url, { method: 'POST', headers, body, redirect: 'manual', signal: ctl.signal }); text = await res.text(); }
      finally { clearTimeout(timer); }
      const vsig = res.headers.get('x-vendor-sig');
      if (res.status < 200 || res.status >= 300) out = { ok: false, status: res.status, error: 'vendor_http_' + res.status, retryable: res.status >= 500 || res.status === 429 };
      else if (text.length > MAX_OUT) out = { ok: false, status: res.status, error: 'vendor_response_too_large', retryable: false };
      else if (!vsig || !(await verify(`${ev.id}\n${await sha(text)}`, vsig, vendor.key))) out = { ok: false, status: res.status, error: 'bad_vendor_signature', retryable: false };
      else { let json; try { json = JSON.parse(text); } catch { json = undefined; }
        out = json && typeof json === 'object' ? { ok: true, status: res.status, json, proof: { event_id: ev.id, body_sha256: await sha(text), vendor_sig: vsig } }
          : { ok: false, status: res.status, error: 'vendor_bad_json', retryable: false }; }
    } catch (e) {
      const msg = String(e && e.message || '');
      out = msg.startsWith('egress_blocked:') ? { ok: false, error: msg, retryable: false }   // SSRF guard (safe-fetch.js) refused the address
        : { ok: false, error: e && e.name === 'AbortError' ? 'vendor_timeout' : 'vendor_unreachable', retryable: true };
    }
    logDelivery({ event_id: ev.id, vendor_id: vendor.id, type, ok: out.ok, status: out.status || null, error: out.error || null, ms: now0() - t0, at: now() });
    return { ...out, event_id: ev.id };
  }
  async function verifyEndpoint(draft) {
    const challenge = rnd(16), r = await deliver(draft, 'endpoint.verify', { challenge, vendor_id: draft.id });
    if (!r.ok) throw E(400, 'webhook_verification_failed', { detail: r.error });
    if (r.json.challenge !== challenge) throw E(400, 'webhook_verification_failed', { detail: 'challenge_mismatch' });
  }

  // Outbox: vendor notifications, vendor payouts, outcome reports and refunds to PayPali. Backoff, 8 attempts, then dead.
  function enqueue(kind, payload) { S.outbox.push({ id: 'job_' + rnd(6), kind, payload, attempts: 0, next_at: now(), state: 'pending', last_error: null }); }
  async function runJob(j) {
    if (j.kind === 'event') {
      const v = S.vendors.get(j.payload.vendor_id); if (!v) return;
      const r = await deliver(v, j.payload.type, j.payload.data, j.payload.event_id || (j.payload.event_id = 'evt_' + rnd(10)));
      if (!r.ok) throw new Error(r.error);
    } else if (j.kind === 'payout') {
      const v = j.payload.vendor_id ? S.vendors.get(j.payload.vendor_id) : null, hold = v ? payoutHold(v) : (ISSUERS.size ? 'payout_vendor_unknown' : null);
      if (hold) throw Object.assign(new Error('payout_held:' + hold), { held: true });
      const r = await PAY.payout({ ...j.payload, binding: v && v.payout_binding ? v.payout_binding : undefined });
      j.held = null;
      const rc = S.receipts.get(j.payload.receipt_id); if (rc) rc.payout = { status: 'paid', payout_id: r.payout_id, amount_minor: j.payload.amount_minor };
    } else if (j.kind === 'outcome') {
      const r = await PAY.reportOutcome(j.payload.charge_id, j.payload.success, j.payload.evidence);
      const rc = S.receipts.get(j.payload.receipt_id); if (rc) rc.stake_settlement = r;
    } else if (j.kind === 'refund') {
      const r = await PAY.refund(j.payload.charge_id, j.payload.reason);
      const rc = S.receipts.get(j.payload.receipt_id); if (rc) rc.refunded = { ...rc.refunded, status: 'refunded', provider: r };
    }
  }
  async function tick() {
    let done = await pullRevocations(false);
    for (const j of S.outbox) {
      if (j.state !== 'pending' || j.next_at > now()) continue;
      j.state = 'running';
      try { await runJob(j); j.state = 'done'; done++; }
      catch (e) {
        if (e && e.held) { j.state = 'pending'; j.held = e.message; j.last_error = e.message; j.next_at = now() + 3600e3; continue; }   // held, not failed: re-check hourly
        j.attempts++; j.last_error = String(e && e.message || e).slice(0, 200);
        j.state = j.attempts >= 8 ? 'dead' : 'pending'; j.next_at = now() + Math.min(3600e3, 1000 * 2 ** j.attempts); }
    }
    if (S.outbox.length > 5000) S.outbox = S.outbox.filter(j => j.state === 'pending' || j.state === 'running');
    return done;
  }
  const vendorOf = key => { const id = S.vendorByKey.get(key); if (!id) throw E(403, 'not_a_vendor'); return S.vendors.get(id); };
  const vendorView = v => ({ vendor_id: v.id, display_name: v.display_name, webhook_url: v.webhook_url, payout_agent_id: v.payout_agent_id, verified_at: v.verified_at,
    identity_verified: vendorLive(v), identity_required: REQUIRE_VENDOR_ID, selling: vendorSellable(v),
    payout_verified: !!v.payout_agent_id && ISSUERS.size > 0 && !payoutHold(v), payout_hold: v.payout_agent_id ? payoutHold(v) : null });
  const priceOk = x => typeof x === 'number' && isFinite(x) && x > 0 && x <= 10000 && Math.round(x * 100) === +(x * 100).toFixed(6);
  function metricOk(m) {
    if (m == null) return null;
    if (typeof m !== 'object' || typeof m.name !== 'string' || !/^[\w.-]{1,40}$/.test(m.name) || typeof m.unit !== 'string' || m.unit.length > 20 || !['higher', 'lower'].includes(m.direction)) throw E(400, 'bad_outcome_metric');
    if (m.success_threshold != null && !(typeof m.success_threshold === 'number' && isFinite(m.success_threshold))) throw E(400, 'bad_outcome_metric');
    return { name: m.name, unit: m.unit, direction: m.direction, ...(m.success_threshold != null ? { success_threshold: m.success_threshold } : {}) };
  }
  function schemaOk(s, name) {
    if (s == null) return null;
    if (JSON.stringify(s).length > 8000) throw E(400, 'bad_' + name, { detail: 'too_large' });
    const e = checkSchemaShape(s); if (e) throw E(400, 'bad_' + name, { detail: e });
    return s;
  }
  // Signed third-party documents (reproductions, audits, measurements, identity credentials).
  async function signedBy(doc, pub) { return !!doc && typeof doc.sig === 'string' && doc.body && typeof doc.body === 'object' && verify(canon(doc.body), doc.sig, pub); }

  /** First attested/measured result of a paid receipt settles the agent's purchase stake at PayPali. */
  function settleStakeOnce(run, success, evidence) {
    const rc = S.receipts.get(run.receipt);
    if (!(rc && rc.payment && rc.payment.charge_id && !rc.outcome_reported && !rc.refunded)) return null;
    rc.outcome_reported = true;
    enqueue('outcome', { receipt_id: rc.doc.body.rid, charge_id: rc.payment.charge_id, success, evidence });
    return 'settling';
  }

  async function route(req) {
    const u = new URL(req.url, 'http://x'), p = u.pathname, m = req.method; let g;
    limit(req.ip ? 'ip:' + req.ip : null, 1);
    if (m === 'GET' && p === '/.well-known/market-keys')
      return { keys: K.map(k => ({ kid: k.kid, alg: 'ed25519', public_key: k.pub, status: k.status, created: k.created })), canonicalization: 'JSON with recursively sorted keys; signature over the "body" object',
        payments: PAY ? (PAY.provider || 'external') : 'credits', ...(PAY && opts.paypaliPublicUrl ? { paypali_url: opts.paypaliPublicUrl } : {}) };
    if (m === 'GET' && p === '/v1/trust') {
      return { identity_issuers: [...ISSUERS.values()].map(i => ({ id: i.id, public_key: i.public_key, revocations_url: i.revocations_url || null })),
        require_vendor_identity: REQUIRE_VENDOR_ID, revoked_subjects: S.revoked.size, min_assurance: Object.keys(ASSURANCE).find(k => ASSURANCE[k] === MIN_ASSURANCE),
        verified_evidence_required: REQUIRE_VERIFIED, max_outcomes_per_identity: MAX_PER_SUBJECT,
        verifiers: [...VERIFIERS.values()].map(v => ({ id: v.id, public_key: v.public_key, measures: v.measures || null })),
        auditors: [...AUDITORS.values()].map(a => ({ id: a.id, public_key: a.public_key, roles: a.roles })),
        refund_after_ms: REFUND_AFTER, tax: 'not_calculated' };
    }
    if (m === 'GET' && p === '/v1/search') {
      const q = (u.searchParams.get('q') || '').toLowerCase(), c = u.searchParams.get('category'), mt = +u.searchParams.get('min_tier') || 1;
      return { results: catalog.filter(s => s.status === 'active' && (!s.vendor_id || vendorSellable(S.vendors.get(s.vendor_id))) && s.tier >= mt && (!c || s.category === c) && (s.name + s.category).toLowerCase().includes(q)).map(listing) };
    }
    if (m === 'GET' && (g = p.match(/^\/v1\/solutions\/([\w-]+)$/))) { const s = find(g[1]); if (!s) throw E(404, 'not_found'); return listing(s); }

    // ---- Auditor submissions (gap 5): signed reproduction reports and audits, bound to the listing hash ----
    if (m === 'POST' && (g = p.match(/^\/v1\/solutions\/([\w-]+)\/(reproductions|audits)$/))) {
      let body; try { body = JSON.parse(req.raw || '{}'); } catch { throw E(400, 'invalid_json'); }
      const s = find(g[1]); if (!s) throw E(404, 'not_found');
      if (s.basis === 'seed') throw E(409, 'seed_listing_not_auditable');
      const doc = body.report || {}, b = doc.body || {}, kind = g[2] === 'reproductions' ? 'reproduction' : 'audit';
      const aud = AUDITORS.get(b.auditor);
      if (!aud) throw E(403, 'unknown_auditor');
      if (!aud.roles.includes(kind === 'reproduction' ? 'reproduce' : 'audit')) throw E(403, 'auditor_role_not_held');
      if (!(await signedBy(doc, aud.public_key))) throw E(400, 'bad_report_signature');
      if (b.kind !== kind || b.solution_id !== s.id) throw E(400, 'report_mismatch');
      const v = S.vendors.get(s.vendor_id);
      if (v && (v.key === aud.public_key || (v.subject && aud.subject && v.subject === aud.subject))) throw E(403, 'auditor_is_vendor');
      if (!(typeof b.iat === 'number' && Math.abs(now() - b.iat) < 7 * 864e5)) throw E(400, 'stale_report');
      await refreshHash(s);
      if (b.listing_hash !== s._hash) throw E(409, 'listing_changed', { current_hash: s._hash });
      let rec;
      if (kind === 'reproduction') {
        if (!(Number.isInteger(b.runs) && b.runs >= 3 && b.runs <= 1000 && Number.isInteger(b.passed) && b.passed >= 0 && b.passed <= b.runs)) throw E(400, 'bad_reproduction_counts');
        rec = { auditor: aud.id, listing_hash: b.listing_hash, runs: b.runs, passed: b.passed, pass: b.passed / b.runs >= s.claim - REPRO_TOL, test_vector_hash: b.test_vector_hash || null, at: now(), sig: doc.sig };
        s.reproductions = s.reproductions.filter(r => !(r.auditor === aud.id && r.listing_hash === b.listing_hash)).concat(rec);
      } else {
        if (!['pass', 'fail'].includes(b.verdict)) throw E(400, 'bad_audit_verdict');
        rec = { auditor: aud.id, listing_hash: b.listing_hash, pass: b.verdict === 'pass', findings_hash: b.findings_hash || null, at: now(), sig: doc.sig };
        s.audits = s.audits.filter(a => !(a.auditor === aud.id && a.listing_hash === b.listing_hash)).concat(rec);
      }
      const before = s.tier; await reeval(s);
      return { recorded: true, kind, pass: rec.pass, tier_before: before, tier_after: s.tier, basis: s.basis_text };
    }

    // ---- Third-party measurement (gap 1): a registered verifier signs the real-world result of a run ----
    if (m === 'POST' && p === '/v1/measurements') {
      let body; try { body = JSON.parse(req.raw || '{}'); } catch { throw E(400, 'invalid_json'); }
      const doc = body.measurement || {}, b = doc.body || {};
      const ver = VERIFIERS.get(b.verifier);
      if (!ver) throw E(403, 'unknown_verifier');
      if (!(await signedBy(doc, ver.public_key))) throw E(400, 'bad_measurement_signature');
      const run = S.runs.get(b.run_id); if (!run || b.kind !== 'measurement' || b.solution_id !== run.solution) throw E(404, 'run_not_found');
      const s = find(run.solution);
      if (s.verifier_id && s.verifier_id !== ver.id) throw E(403, 'not_this_listings_verifier');
      if (typeof b.success !== 'boolean') throw E(400, 'success_must_be_boolean');
      if (b.value != null && !(typeof b.value === 'number' && isFinite(b.value))) throw E(400, 'bad_value');
      if (!run.outcome) { run.outcome = { run_id: run.run_id, principal: run.principal, agent: run.agent, agent_success: null, success: null, observed: null, attested: false, at: now(), paid_minor: run.paid_minor }; s.outcomes.push(run.outcome); }
      if (run.outcome.measurement) throw E(409, 'already_measured');
      run.outcome.measurement = { verifier: ver.id, value: b.value ?? null, success: b.success, at: now(), sig: doc.sig };
      const before = s.tier; await reeval(s);
      const stake = settleStakeOnce(run, b.success, { run_id: run.run_id, measured_by: ver.id, value: b.value ?? null, solution_id: s.id });
      return { recorded: true, tier_before: before, tier_after: s.tier, purchase_stake: stake, verification: stats(s) };
    }

    // PayPali -> marketplace webhooks are authenticated by the payments adapter (HMAC), not by X-Sig.
    if (m === 'POST' && p === '/v1/paypali/webhooks') {
      if (!PAY) throw E(404, 'not_found');
      if (!(await PAY.verifyWebhook(req.headers, req.raw))) throw E(401, 'bad_webhook_signature');
      let ev; try { ev = JSON.parse(req.raw); } catch { throw E(400, 'invalid_json'); }
      if (S.seenEvents.has(ev.id)) return { received: true, duplicate: true };
      S.seenEvents.add(ev.id);
      let affected = 0;
      if (ev.type === 'grant.revoked') {
        for (const md of S.mandates.values()) if (md.funding && md.funding.grant_id === ev.data.grant_id && !md.revoked) { md.revoked = true; md.revoked_by = 'paypali'; affected++; }
      }
      return { received: true, type: ev.type, mandates_revoked: affected };
    }
    if (m === 'POST' && p === '/v1/identity/revocations') {
      let body; try { body = JSON.parse(req.raw || '{}'); } catch { throw E(400, 'invalid_json'); }
      return applyRevocation(body.revocation);
    }
    // Market key rotation (gap 4): admin only; retired keys stay published so old receipts still verify.
    if (m === 'POST' && p === '/v1/admin/rotate-market-key') {
      if (!opts.adminToken || req.headers['x-admin-token'] !== opts.adminToken) throw E(404, 'not_found');
      const old = active(); old.status = 'retired'; const k = await addKey();
      return { active_kid: k.kid, retired_kid: old.kid };
    }

    const key = await auth(req);
    const costly = p === '/v1/invoke' ? 5 : (p === '/v1/vendors' || p.endsWith('/rotate')) ? 10 : 1;
    limit('key:' + key, costly);
    let body; try { body = req.raw ? JSON.parse(req.raw) : {}; } catch { throw E(400, 'invalid_json'); }

    // ---- Vendors ----
    if (m === 'POST' && p === '/v1/vendors') {
      const name = String(body.display_name || '').trim();
      if (!name || name.length > 80) throw E(400, 'bad_display_name');
      const url = checkWebhookUrl(body.webhook_url);
      if (body.payout_agent_id != null && (typeof body.payout_agent_id !== 'string' || !/^[\w-]{8,64}$/.test(body.payout_agent_id))) throw E(400, 'bad_payout_agent_id');
      // Every seller is an agent: with requireSellerAgent, a vendor must name the PayPali agent it sells as (and is paid into).
      if (opts.requireSellerAgent && PAY && !body.payout_agent_id) throw E(400, 'seller_agent_required', { hint: 'Connect PayPali on the Sell tab, or pass payout_agent_id with a payout_binding from PayPali' });
      const id = S.vendorByKey.get(key) || 'vnd_' + (await sha(key)).slice(0, 16);
      const draft = { id, key, display_name: name, webhook_url: url, payout_agent_id: body.payout_agent_id || null };
      const pr = S.byKey.get(key), live = liveSubject(pr);
      if (REQUIRE_VENDOR_ID && !live) throw E(403, 'vendor_identity_required', { hint: 'register this key as a principal (POST /v1/principals) and attach an identity credential (POST /v1/principals/me/identity) first' });
      let payout_binding = null;
      if (body.payout_agent_id != null && ISSUERS.size) {
        const pb = body.payout_binding || {}, b = pb.body || {}, iss = ISSUERS.get(b.issuer);
        if (!iss) throw E(400, 'payout_binding_required', { hint: 'PayPali: POST /api/owners/:ownerId/payout-bindings {agentId, vendorPub}' });
        if (b.kind !== 'payout_binding' || !(await signedBy(pb, iss.public_key))) throw E(400, 'bad_payout_binding');
        if (b.vendor_pub !== key || b.paypali_agent_id !== body.payout_agent_id) throw E(400, 'payout_binding_mismatch');
        if (!(b.exp > now())) throw E(400, 'payout_binding_expired');
        if (live !== b.issuer + ':' + b.subject) throw E(403, 'payout_binding_not_vendor_identity');
        payout_binding = { body: b, sig: pb.sig };
      }
      await verifyEndpoint(draft);
      const prev = S.vendors.get(id);
      const v = { ...(prev || { created_at: now(), principal_id: await idOf('prn', key) }), ...draft, payout_binding, verified_at: now(), subject: prev?.subject || live };
      S.vendors.set(id, v); S.vendorByKey.set(key, id);
      if (prev && prev.webhook_url !== url) { for (const s of catalog) if (s.vendor_id === id) await refreshHash(s); await reevalVendor(id); }
      return vendorView(v);
    }
    if (m === 'POST' && p === '/v1/vendors/me/rotate') {
      const v = vendorOf(key), np = body.new_pub;
      try { await imp(np); } catch { throw E(400, 'bad_new_key'); }
      if (S.vendorByKey.has(np) || S.byKey.has(np)) throw E(409, 'key_in_use');
      if (!(await verify(`rotate-vendor\n${key}\n${np}`, body.proof || '', np))) throw E(400, 'bad_rotation_proof');
      await verifyEndpoint({ ...v, key: np });                 // the endpoint must already sign with the new key
      S.vendorByKey.delete(key); v.key = np; S.vendorByKey.set(np, v.id); v.rotated_at = now();
      return vendorView(v);
    }
    if (m === 'GET' && p === '/v1/vendors/me') {
      const v = vendorOf(key);
      for (const s of catalog) if (s.vendor_id === v.id) await refreshHash(s);
      return { ...vendorView(v), listings: catalog.filter(s => s.vendor_id === v.id).map(listing),
        earnings: S.vendorEarnings.get(v.principal_id) || 0,
        deliveries: S.deliveries.filter(d => d.vendor_id === v.id).slice(-50).reverse(),
        pending_events: S.outbox.filter(j => j.kind === 'event' && j.payload.vendor_id === v.id && j.state === 'pending').length };
    }
    // New listings always start at V1: tiers come from signed reproductions/audits and outcome evidence, never declarations.
    if (m === 'POST' && p === '/v1/solutions') {
      const v = vendorOf(key), name = String(body.name || '').trim(), category = String(body.category || '').trim();
      if (!name || name.length > 80) throw E(400, 'bad_name');
      if (!/^[A-Za-z][\w &-]{1,30}$/.test(category)) throw E(400, 'bad_category');
      if (!priceOk(body.price)) throw E(400, 'bad_price');
      if (!(typeof body.claimed_success === 'number' && body.claimed_success > 0 && body.claimed_success < 1)) throw E(400, 'bad_claimed_success');
      const runs = body.runs_included == null ? 4 : body.runs_included;
      if (!(Number.isInteger(runs) && runs >= 1 && runs <= 100)) throw E(400, 'bad_runs_included');
      const input_schema = schemaOk(body.input_schema, 'input_schema'), output_schema = schemaOk(body.output_schema, 'output_schema');
      const outcome_metric = metricOk(body.outcome_metric);
      if (body.verifier_id != null && !VERIFIERS.has(body.verifier_id)) throw E(400, 'unknown_verifier');
      if (catalog.filter(s => s.vendor_id === v.id).length >= 50) throw E(429, 'listing_limit');
      const s = { id: 'sf-v' + rnd(5), name, category, price: body.price, price_minor: Math.round(body.price * 100), tier: 1, claim: body.claimed_success,
        vendor_principal: v.principal_id, vendor_id: v.id, fulfillment: 'webhook', status: 'active', blurb: String(body.blurb || '').slice(0, 280),
        runs_included: runs, input_schema, output_schema, outcome_metric, verifier_id: body.verifier_id || null, basis: 'computed',
        reproductions: [], audits: [], non_deliveries: 0, outcomes: [], history: [], created_at: now() };
      catalog.push(s); await refreshHash(s); await reeval(s);
      return listing(s);
    }
    if (m === 'PATCH' && (g = p.match(/^\/v1\/solutions\/([\w-]+)$/))) {
      const v = vendorOf(key), s = find(g[1]);
      if (!s || s.vendor_id !== v.id) throw E(404, 'not_found');
      for (const k of Object.keys(body)) if (!['price', 'blurb', 'status', 'runs_included'].includes(k)) throw E(400, 'field_not_editable', { field: k });
      if (body.price !== undefined) { if (!priceOk(body.price)) throw E(400, 'bad_price'); s.price = body.price; s.price_minor = Math.round(body.price * 100); }
      if (body.blurb !== undefined) s.blurb = String(body.blurb).slice(0, 280);
      if (body.status !== undefined) { if (!['active', 'paused'].includes(body.status)) throw E(400, 'bad_status'); s.status = body.status; }
      if (body.runs_included !== undefined) { if (!(Number.isInteger(body.runs_included) && body.runs_included >= 1 && body.runs_included <= 100)) throw E(400, 'bad_runs_included'); s.runs_included = body.runs_included; }
      await refreshHash(s); await reeval(s);   // a changed hash lapses reproductions/audits; a price change reweights evidence
      return listing(s);
    }

    // ---- Principals + identity (gap 1) ----
    if (m === 'POST' && p === '/v1/principals') {
      let pr = S.byKey.get(key);
      if (!pr) { pr = { id: await idOf('prn', key), key, balance: 0 }; S.byKey.set(key, pr); S.principals.set(pr.id, pr); }
      return { principal_id: pr.id, balance: pr.balance };
    }
    if (m === 'GET' && p === '/v1/principals/me') {
      const pr = principalOf(key), id = pr.identity;
      return { principal_id: pr.id, balance: pr.balance, identity: id ? { issuer: id.issuer, level: id.level, assurance: id.assurance, exp: id.exp, counts_as_evidence: !!liveSubject(pr) } : null };
    }
    if (m === 'POST' && p === '/v1/principals/me/identity') {
      const pr = principalOf(key), doc = body.credential || {}, b = doc.body || {};
      const iss = ISSUERS.get(b.issuer);
      if (!iss) throw E(403, 'unknown_identity_issuer');
      if (!(await signedBy(doc, iss.public_key))) throw E(400, 'bad_credential_signature');
      if (b.kind !== 'identity' || b.principal_pub !== key) throw E(400, 'credential_not_for_this_key');
      if (!['human', 'org'].includes(b.level) || !ASSURANCE[b.assurance]) throw E(400, 'bad_credential_fields');
      if (!(typeof b.subject === 'string' && b.subject.length >= 16 && b.subject.length <= 128)) throw E(400, 'bad_credential_subject');
      if (!(b.exp > now())) throw E(400, 'credential_expired');
      const subj = b.issuer + ':' + b.subject;
      // One person = one BUYING principal. {as: "vendor"} binds the same person to one vendor key as well: a person may
      // both buy and sell. A vendor-only key cannot sign mandates (so it can never buy or attest), and evidence is counted
      // per person anyway (capped per subject; a vendor's own subject never counts on its listings).
      const asVendor = body.as === 'vendor' && S.subjects.get(subj) !== pr.id;
      const map = asVendor ? S.vendorSubjects : S.subjects;
      let holder = map.get(subj);
      if (S.revoked.has(subj)) throw E(403, 'identity_revoked');
      // The person's vendor key moves to a NEWER credential from the issuer (e.g. the old key was lost with a browser tab).
      // An older credential can never displace a newer one. The old key's listings stop selling until re-verified.
      const old = asVendor && holder && holder !== pr.id ? S.principals.get(holder) : null;
      if (old && (!old.identity || (old.identity.iat || 0) < (b.iat || 0))) {
        old.identity = null; old.vendor_replaced = { at: now(), by: pr.id }; map.delete(subj); holder = null;
        const ov = S.vendors.get(S.vendorByKey.get(old.key)); if (ov) await reevalVendor(ov.id);
      }
      if (holder && holder !== pr.id) throw E(409, 'identity_already_bound', { hint: asVendor ? 'one person or organisation = one vendor key; rotate the existing vendor key instead'
        : 'one person or organisation = one principal; rotate the existing principal key instead (to sell with another key, attach it with {"as": "vendor"})' });
      if (pr.identity && pr.identity.issuer + ':' + pr.identity.subject !== subj) map.delete(pr.identity.issuer + ':' + pr.identity.subject);
      map.set(subj, pr.id);
      pr.identity = { issuer: b.issuer, subject: b.subject, level: b.level, assurance: b.assurance, exp: b.exp, iat: b.iat || 0 };
      pr.vendor_only = asVendor;
      const ns = liveSubject(pr);
      if (ns) {
        // Same principal, stronger identity (e.g. dev -> kyc): carry its past evidence over so the per-identity cap still applies.
        for (const s2 of catalog) for (const o of s2.outcomes) if (o.principal === pr.id && o.subject && o.subject !== ns && !S.revoked.has(o.subject)) o.subject = ns;
        for (const v of S.vendors.values()) if (v.principal_id === pr.id && v.subject !== ns) { if (v.subject) v.past_subjects = [...(v.past_subjects || []), v.subject]; v.subject = ns; }
        for (const s2 of catalog) await reeval(s2);
      }
      return { principal_id: pr.id, identity: { issuer: b.issuer, level: b.level, assurance: b.assurance, exp: b.exp, counts_as_evidence: !!liveSubject(pr) } };
    }
    if (m === 'POST' && p === '/v1/principals/me/rotate') {
      const pr = principalOf(key), np = body.new_pub;
      try { await imp(np); } catch { throw E(400, 'bad_new_key'); }
      if (S.byKey.has(np) || S.vendorByKey.has(np)) throw E(409, 'key_in_use');
      if (!(await verify(`rotate-principal\n${key}\n${np}`, body.proof || '', np))) throw E(400, 'bad_rotation_proof');
      S.byKey.delete(key); pr.key = np; S.byKey.set(np, pr); pr.rotated_at = now();
      return { principal_id: pr.id, rotated: true, note: 'existing mandates stay valid; new mandates must be signed by the new key' };
    }
    if (m === 'POST' && p === '/v1/principals/me/fund') {
      if (!DEMO) throw E(404, 'not_found');
      const pr = principalOf(key); if (!(body.amount > 0 && body.amount <= 10000)) throw E(400, 'bad_amount');
      pr.balance += body.amount; return { balance: pr.balance };
    }
    if (m === 'POST' && p === '/v1/mandates') {
      const pr = principalOf(key), mand = body.mandate || {}, mb = mand.body || {};
      if (mb.principal_pub !== key) throw E(403, 'principal_key_mismatch');
      if (pr.vendor_only) throw E(403, 'vendor_key_cannot_buy', { hint: 'this key is verified as a vendor only; buy with your own principal key' });
      if (!(await verify(canon(mb), mand.sig || '', key))) throw E(400, 'bad_mandate_signature');
      if (typeof mb.mid !== 'string' || mb.mid.length < 8 || S.mandates.has(mb.mid)) throw E(400, 'bad_mandate_id');
      if (!(mb.budget > 0 && mb.cap > 0 && mb.min_tier >= 1 && mb.min_tier <= 4 && Array.isArray(mb.categories))) throw E(400, 'bad_mandate_fields');
      if (!(mb.exp > now() && mb.exp < now() + 30 * 864e5)) throw E(400, 'bad_expiry');
      try { await imp(mb.agent_pub); } catch { throw E(400, 'bad_agent_key'); }
      let funding = null;
      if (mb.funding !== undefined || (PAY && opts.requireFunding !== false)) {
        if (!PAY) throw E(400, 'payments_not_configured');
        const f = mb.funding || {};
        if (f.provider !== 'paypali' || typeof f.grant_id !== 'string') throw E(400, 'funding_required', { expected: { provider: 'paypali', grant_id: '<PayPali merchant grant id>' } });
        let gr; try { gr = await PAY.getGrant(f.grant_id); } catch { throw E(502, 'payment_provider_unavailable'); }
        if (!gr || gr.status !== 'ACTIVE') throw E(402, 'grant_not_active');
        if (gr.currency !== 'USD') throw E(400, 'grant_currency_not_supported');
        // A grant bound to a principal key (PayPali "Connect PayPali") funds that principal's mandates only.
        if (gr.principalPub && gr.principalPub !== key) throw E(403, 'grant_bound_to_other_principal');
        funding = { provider: 'paypali', grant_id: f.grant_id, paypali_agent_id: gr.agentId };
      } else {
        if (mb.budget > pr.balance) throw E(402, 'insufficient_principal_balance');
        pr.balance -= mb.budget;
      }
      S.mandates.set(mb.mid, { mb, sig: mand.sig, principal: pr.id, agent: await idOf('agt', mb.agent_pub), spent: 0, revoked: false, hash: await sha(canon(mb)), funding });
      return { mandate_id: mb.mid, agent_id: await idOf('agt', mb.agent_pub), principal_id: pr.id, held: funding ? 0 : mb.budget, funding };
    }
    if ((g = p.match(/^\/v1\/mandates\/([\w-]+)(\/revoke)?$/))) {
      const md = S.mandates.get(g[1]); if (!md) throw E(404, 'not_found');
      const isP = S.byKey.get(key)?.id === md.principal, isA = md.mb.agent_pub === key;   // by principal id: survives key rotation
      if (!isP && !isA) throw E(403, 'not_a_party');
      if (m === 'POST' && g[2]) { if (!isP) throw E(403, 'principal_only'); md.revoked = true; }
      release(md);
      return { mandate_id: md.mb.mid, revoked: md.revoked, expired: md.mb.exp < now(), budget: md.mb.budget, spent: md.spent, remaining: md.revoked ? 0 : md.mb.budget - md.spent,
        principal_balance: S.principals.get(md.principal).balance, exp: md.mb.exp, funding: md.funding, revoked_by: md.revoked_by || null };
    }
    if (m === 'POST' && p === '/v1/quote') {
      const md = mctx(req, key), s = find(body.solution_id); if (!s) throw E(404, 'solution_not_found');
      if (s.status !== 'active') throw E(409, 'listing_paused');
      if (s.vendor_id && !vendorSellable(S.vendors.get(s.vendor_id))) throw E(409, 'vendor_identity_lapsed');
      const reasons = denyReasons(md, s), qid = 'q_' + rnd(8);
      const doc = await sign({ kind: 'quote', qid, solution_id: s.id, price: s.price, amount_minor: s.price_minor, currency: 'USD', tier: s.tier,
        payment: md.funding ? 'paypali' : 'credits', mandate_id: md.mb.mid, agent_id: md.agent, exp: now() + 60000, allowed: !reasons.length, reasons });
      S.quotes.set(qid, { doc, receipt: null }); return doc;
    }
    if (m === 'POST' && p === '/v1/purchase') {
      const md = mctx(req, key), q = S.quotes.get(body.quote_id);
      if (!q || q.doc.body.mandate_id !== md.mb.mid) throw E(404, 'quote_not_found');
      if (q.receipt) return S.receipts.get(q.receipt).doc;
      if (q.charging) throw E(409, 'purchase_in_progress');
      if (q.doc.body.exp < now() && !q.charge_unknown) throw E(410, 'quote_expired');
      const s = find(q.doc.body.solution_id);
      if (s.price_minor !== q.doc.body.amount_minor) throw E(409, 'price_changed', { quoted: q.doc.body.price, now: s.price });
      if (s.status !== 'active' && !q.charge_unknown) throw E(409, 'listing_paused');
      if (s.vendor_id && !vendorSellable(S.vendors.get(s.vendor_id)) && !q.charge_unknown) throw E(409, 'vendor_identity_lapsed');
      const reasons = denyReasons(md, s);
      if (reasons.length) throw E(403, 'mandate_violation', { reasons });
      let payment = null;
      if (md.funding) {
        const conf = body.confidence_pct;
        if (!(Number.isInteger(conf) && conf >= 1 && conf <= 99)) throw E(400, 'confidence_pct_required', { hint: 'integer 1..99: your honest P(this purchase yields a confirmed success)' });
        const intent = body.intent_key == null ? `bazaar:${s.id}:${q.doc.body.qid}` : String(body.intent_key);
        if (!intent || intent.length > 120) throw E(400, 'bad_intent_key');
        md.spent += s.price; q.charging = true;
        let r;
        try {
          r = await PAY.charge({ grant_id: md.funding.grant_id, amount_minor: s.price_minor, currency: 'USD', idempotency_key: 'bz:' + q.doc.body.qid,
            reference: s.id + ':' + q.doc.body.qid, intent_key: intent, confidence_pct: conf });
        } catch (e) { md.spent -= s.price; q.charging = false; q.charge_unknown = true; throw E(502, 'payment_pending', { retry: 'POST /v1/purchase with the same quote_id' }); }
        q.charging = false;
        if (r.status !== 'PAID') { md.spent -= s.price; q.charge_unknown = false; throw E(402, 'payment_declined', { reasons: r.reasons || [], score_quote: r.score_quote || null }); }
        if (q.receipt) return S.receipts.get(q.receipt).doc;
        payment = { provider: 'paypali', charge_id: r.charge_id, stake_id: r.stake_id || null, amount_minor: s.price_minor, currency: 'USD', confidence_pct: conf, intent_key: intent };
      } else {
        md.spent += s.price;
      }
      S.vendorEarnings.set(s.vendor_principal, (S.vendorEarnings.get(s.vendor_principal) || 0) + s.price * (1 - FEE));
      const doc = await sign({ kind: 'receipt', rid: 'rc_' + rnd(8), solution_id: s.id, price: s.price, price_minor: s.price_minor, tier_at_purchase: s.tier, runs_included: s.runs_included,
        principal_id: md.principal, agent_id: md.agent, mandate_id: md.mb.mid, mandate_hash: md.hash, quote_id: q.doc.body.qid, iat: now(), payment,
        tax: { status: 'not_calculated', amount_minor: 0 } });
      S.receipts.set(doc.body.rid, { doc, runs_left: s.runs_included, payment, delivered: false, failed_deliveries: 0, outcome_reported: false }); q.receipt = doc.body.rid;
      if (s.vendor_id) enqueue('event', { vendor_id: s.vendor_id, type: 'order.purchased', data: { receipt_id: doc.body.rid, solution_id: s.id, price: s.price,
        runs_included: s.runs_included, agent_id: md.agent, paid_with: payment ? 'paypali' : 'credits' } });
      return doc;
    }
    if (m === 'POST' && p === '/v1/invoke') {
      const md = mctx(req, key), rc = S.receipts.get(body.receipt_id);
      if (!rc || rc.doc.body.agent_id !== md.agent || rc.doc.body.mandate_id !== md.mb.mid) throw E(403, 'receipt_not_owned');
      if (rc.refunded) throw E(410, 'receipt_refunded');
      if (rc.runs_left <= 0) throw E(402, 'runs_exhausted');
      const s = find(rc.doc.body.solution_id); let output, proof = null;
      const input = body.input || {};
      if (s.input_schema) { const errs = validate(s.input_schema, input); if (errs.length) throw E(400, 'input_invalid', { errors: errs }); }
      const run_id = 'run_' + rnd(8);
      if (s.fulfillment === 'webhook') {
        if (rc.in_flight) throw E(409, 'invoke_in_progress');
        const v = S.vendors.get(s.vendor_id);
        if (JSON.stringify(input).length > 64 * 1024) throw E(413, 'input_too_large');
        rc.in_flight = true;
        let r; const evId = 'evt_' + rnd(10);
        try {
          for (let attempt = 1; attempt <= 2; attempt++) {
            r = await deliver(v, 'solution.invoke', { run_id, receipt_id: rc.doc.body.rid, solution_id: s.id, input }, evId);
            if (r.ok || !r.retryable) break;
          }
        } finally { rc.in_flight = false; }
        // A failed or invalid delivery does NOT consume a run; it counts toward the non-delivery refund rule.
        if (!r.ok) { rc.failed_deliveries++; throw E(502, 'vendor_unavailable', { detail: r.error, event_id: r.event_id, refund_eligible: refundCheck(rc, s).ok }); }
        if (!('output' in r.json)) { rc.failed_deliveries++; throw E(502, 'vendor_bad_response', { event_id: r.event_id }); }
        if (s.output_schema) { const errs = validate(s.output_schema, r.json.output); if (errs.length) { rc.failed_deliveries++; throw E(502, 'vendor_output_invalid', { errors: errs, event_id: r.event_id }); } }
        output = r.json.output; proof = r.proof;
        if (!rc.delivered) {
          rc.delivered = true;
          if (rc.payment && v.payout_agent_id) enqueue('payout', { receipt_id: rc.doc.body.rid, vendor_id: v.id, to_agent_id: v.payout_agent_id,
            amount_minor: Math.floor(rc.payment.amount_minor * (1 - FEE)), currency: 'USD', idempotency_key: 'payout:' + rc.doc.body.rid });
        }
      } else {
        try { output = runFns.get(s.id)(input); } catch { throw E(502, 'vendor_error'); }
        if (s.output_schema) { const errs = validate(s.output_schema, output); if (errs.length) throw E(502, 'vendor_output_invalid', { errors: errs }); }
        rc.delivered = true;
      }
      rc.runs_left--;
      S.runs.set(run_id, { run_id, receipt: rc.doc.body.rid, solution: s.id, agent: md.agent, principal: md.principal, outcome: null, proof, paid_minor: rc.doc.body.price_minor ?? Math.round(rc.doc.body.price * 100) });
      return { run_id, output, runs_left: rc.runs_left, delivery: proof };
    }
    // ---- Refunds (gap 4): money back when a vendor never delivered ----
    if (m === 'POST' && (g = p.match(/^\/v1\/receipts\/([\w-]+)\/refund$/))) {
      const rc = S.receipts.get(g[1]); if (!rc) throw E(404, 'not_found');
      const b = rc.doc.body, isAgent = (await idOf('agt', key)) === b.agent_id, isP = S.byKey.get(key)?.id === b.principal_id;
      if (!isAgent && !isP) throw E(403, 'not_a_party');
      if (rc.refunded) return { refunded: true, ...rc.refunded, replayed: true };
      const s = find(b.solution_id), chk = refundCheck(rc, s);
      if (!chk.ok) throw E(409, 'refund_not_eligible', { reason: chk.reason });
      rc.refunded = { at: now(), reason: 'non_delivery', status: rc.payment ? 'pending' : 'refunded' }; rc.runs_left = 0;
      s.non_deliveries = (s.non_deliveries || 0) + 1;
      const md = S.mandates.get(b.mandate_id);
      if (md && !md.funding) { if (md.released) S.principals.get(md.principal).balance += b.price; else md.spent = Math.max(0, md.spent - b.price); }
      else if (md) md.spent = Math.max(0, md.spent - b.price);
      S.vendorEarnings.set(s.vendor_principal, (S.vendorEarnings.get(s.vendor_principal) || 0) - b.price * (1 - FEE));
      if (rc.payment && rc.payment.charge_id) {
        rc.outcome_reported = true;   // the refund settles the purchase stake (a purchase that never delivered is a failed purchase)
        try { const r = await PAY.refund(rc.payment.charge_id, 'non_delivery'); rc.refunded = { ...rc.refunded, status: 'refunded', provider: r }; }
        catch (e) { enqueue('refund', { receipt_id: b.rid, charge_id: rc.payment.charge_id, reason: 'non_delivery' }); }
      }
      if (s.vendor_id) enqueue('event', { vendor_id: s.vendor_id, type: 'order.refunded', data: { receipt_id: b.rid, solution_id: s.id, reason: 'non_delivery' } });
      return { refunded: true, ...rc.refunded };
    }
    // Step 1 of the outcome loop: the agent reports. Provisional; never counts toward tiers by itself.
    if (m === 'POST' && p === '/v1/outcomes') {
      const run = S.runs.get(body.run_id); if (!run) throw E(404, 'run_not_found');
      if (run.agent !== await idOf('agt', key)) throw E(403, 'not_your_run');
      if (run.outcome && run.outcome.agent_success !== null) throw E(409, 'outcome_already_reported');
      if (typeof body.success !== 'boolean') throw E(400, 'success_must_be_boolean');
      if (body.observed != null && !(typeof body.observed === 'number' && isFinite(body.observed))) throw E(400, 'observed_must_be_number');
      const s = find(run.solution);
      if (s.vendor_principal === run.principal) throw E(403, 'vendor_cannot_self_report');
      if (run.outcome) Object.assign(run.outcome, { agent_success: body.success, observed: body.observed ?? null, evidence_hash: body.evidence_hash || null });   // already measured
      else {
        const o = { run_id: run.run_id, principal: run.principal, agent: run.agent, agent_success: body.success, success: body.success, observed: body.observed ?? null,
          evidence_hash: body.evidence_hash || null, attested: false, at: now(), paid_minor: run.paid_minor };
        s.outcomes.push(o); run.outcome = o;
      }
      return { recorded: true, provisional: true, awaiting: 'principal_attestation', verification: stats(s) };
    }
    if (m === 'GET' && p === '/v1/principals/me/pending') {
      const pr = principalOf(key);
      return { pending: [...S.runs.values()].filter(r => r.principal === pr.id && r.outcome && r.outcome.agent_success !== null && !r.outcome.attested)
        .map(r => { const s = find(r.solution); return { run_id: r.run_id, solution_id: r.solution, solution_name: s.name, agent_reported_success: r.outcome.agent_success,
          observed: r.outcome.observed, outcome_metric: s.outcome_metric || null, measured: r.outcome.measurement ? { success: r.outcome.measurement.success, value: r.outcome.measurement.value } : null, at: r.outcome.at }; }) };
    }
    // Step 2: the human principal records what THEY observed (gap 6). With a metric, the human's number decides;
    // it is compared to the agent's claim and mismatches are recorded against the run.
    if (m === 'POST' && p === '/v1/outcomes/attest') {
      const pr = principalOf(key), run = S.runs.get(body.run_id); if (!run) throw E(404, 'run_not_found');
      if (run.principal !== pr.id) throw E(403, 'not_your_run');
      if (!run.outcome || run.outcome.agent_success === null) throw E(409, 'no_outcome_to_attest');
      if (run.outcome.attested) throw E(409, 'already_attested');
      const o = run.outcome, s = find(run.solution), metric = s.outcome_metric, before = s.tier;
      const obs = body.observed;
      if (obs != null && !(typeof obs === 'number' && isFinite(obs))) throw E(400, 'observed_must_be_number');
      let success;
      if (metric && metric.success_threshold != null) {
        if (obs == null) throw E(400, 'observed_required', { metric });
        success = metric.direction === 'higher' ? obs >= metric.success_threshold : obs <= metric.success_threshold;
      } else {
        if (metric && obs == null) throw E(400, 'observed_required', { metric });
        if (body.verdict !== 'confirm' && body.verdict !== 'dispute') throw E(400, 'verdict_must_be_confirm_or_dispute');
        success = body.verdict === 'confirm' ? o.agent_success : !o.agent_success;   // binary outcome: a dispute flips the agent's claim
      }
      o.success = success; o.attested = true; o.attested_at = now(); o.human_note = String(body.note || '').slice(0, 200);
      o.verdict = body.verdict || null; o.human_observed = obs ?? null;
      o.observation_mismatch = (obs != null && typeof o.observed === 'number') ? Math.abs(o.observed - obs) > Math.max(OBS_TOL * Math.abs(obs), 0.01) : null;
      o.subject = liveSubject(pr);
      await reeval(s);
      const stake = settleStakeOnce(run, o.measurement ? o.measurement.success : success, { run_id: run.run_id, verdict: o.verdict, human_observed: o.human_observed,
        agent_observed: o.observed, observation_mismatch: o.observation_mismatch, agent_reported_success: o.agent_success, note: o.human_note, solution_id: s.id, vendor_proof: run.proof });
      if (s.vendor_id) enqueue('event', { vendor_id: s.vendor_id, type: 'outcome.attested', data: { run_id: run.run_id, solution_id: s.id, final_success: success, tier_after: s.tier } });
      return { attested: true, agreed: success === o.agent_success, final_success: success, human_observed: o.human_observed, agent_observed: o.observed,
        observation_mismatch: o.observation_mismatch, counts_as_evidence: !!o.subject || !REQUIRE_VERIFIED, tier_before: before, tier_after: s.tier, verification: stats(s), purchase_stake: stake };
    }
    if (m === 'GET' && (g = p.match(/^\/v1\/receipts\/([\w-]+)$/))) {
      const rc = S.receipts.get(g[1]); if (!rc) throw E(404, 'not_found');
      const b = rc.doc.body; if (await idOf('agt', key) !== b.agent_id && S.byKey.get(key)?.id !== b.principal_id) throw E(403, 'not_a_party');
      const s = find(b.solution_id);
      return { ...rc.doc, runs_left: rc.runs_left, delivered: !!rc.delivered, failed_deliveries: rc.failed_deliveries || 0, refund: rc.refunded || null,
        refund_eligible: refundCheck(rc, s).ok, payout: rc.payout || null, stake_settlement: rc.stake_settlement || null };
    }
    throw E(404, 'not_found');
  }

  /** Non-delivery refund rule: vendor-fulfilled, never delivered, and either 2+ failed deliveries or REFUND_AFTER elapsed. */
  function refundCheck(rc, s) {
    if (rc.refunded) return { ok: false, reason: 'already_refunded' };
    if (s.fulfillment !== 'webhook') return { ok: false, reason: 'not_vendor_fulfilled' };
    if (rc.delivered) return { ok: false, reason: 'delivered' };
    if ((rc.failed_deliveries || 0) >= 2 || now() - rc.doc.body.iat >= REFUND_AFTER) return { ok: true };
    return { ok: false, reason: 'vendor_still_within_delivery_window' };
  }

  async function handle(req) {
    try { return { status: 200, body: await route(req) }; }
    catch (e) { if (!e.code) console.error(e); return { status: e.code || 500, body: { error: e.code ? e.message : 'internal_error', ...(e.extra || {}) } }; }
  }

  // ---------------------------------------------------------------------------
  // Persistence (gap 4): a full snapshot, including market signing keys — server.js
  // encrypts it at rest. Runs share outcome objects with listings; relinked on import.
  // ---------------------------------------------------------------------------
  async function exportState() {
    const keys = [];
    for (const k of K) keys.push({ kid: k.kid, pub: k.pub, status: k.status, created: k.created, pkcs8: b64u(new Uint8Array(await subtle.exportKey('pkcs8', k.priv))) });
    return { v: 1, saved_at: now(), market_keys: keys,
      catalog: catalog.map(({ run, ...s }) => s),
      principals: [...S.principals.values()], mandates: [...S.mandates.values()], quotes: [...S.quotes.entries()], receipts: [...S.receipts.entries()],
      runs: [...S.runs.values()], nonces: [...S.nonces.entries()], vendorEarnings: [...S.vendorEarnings.entries()], vendors: [...S.vendors.values()],
      deliveries: S.deliveries, outbox: S.outbox, seenEvents: [...S.seenEvents], subjects: [...S.subjects.entries()], vendorSubjects: [...S.vendorSubjects.entries()], revoked: [...S.revoked] };
  }
  if (st) {
    const seedIds = new Set(SEED.map(s => s.id));
    catalog = st.catalog.map(s => ({ reproductions: [], audits: [], non_deliveries: 0, ...s }));
    for (const s of SEED) if (!catalog.some(x => x.id === s.id)) catalog.push(s);
    void seedIds;
    for (const p of st.principals || []) { S.principals.set(p.id, p); S.byKey.set(p.key, p); }
    for (const md of st.mandates || []) S.mandates.set(md.mb.mid, md);
    for (const [k, q] of st.quotes || []) { q.charging = false; S.quotes.set(k, q); }
    for (const [k, r] of st.receipts || []) { r.in_flight = false; S.receipts.set(k, r); }
    const byRun = new Map(); for (const s of catalog) for (const o of s.outcomes) byRun.set(o.run_id, o);
    for (const r of st.runs || []) { if (r.outcome) r.outcome = byRun.get(r.run_id) || r.outcome; S.runs.set(r.run_id, r); }
    for (const [k, t] of st.nonces || []) S.nonces.set(k, t);
    for (const [k, v] of st.vendorEarnings || []) S.vendorEarnings.set(k, v);
    for (const v of st.vendors || []) { S.vendors.set(v.id, v); S.vendorByKey.set(v.key, v.id); }
    S.deliveries = st.deliveries || []; S.outbox = (st.outbox || []).map(j => j.state === 'running' ? { ...j, state: 'pending' } : j);
    for (const e of st.seenEvents || []) S.seenEvents.add(e);
    for (const [k, v] of st.subjects || []) S.subjects.set(k, v);
    for (const [k, v] of st.vendorSubjects || []) S.vendorSubjects.set(k, v);
    for (const k of st.revoked || []) S.revoked.add(k);
  }
  for (const s of catalog) { await refreshHash(s); await reeval(s); }

  const marketKeys = () => K.map(k => ({ kid: k.kid, pub: k.pub, status: k.status }));
  return { handle, tick, exportState, marketKeys, pullRevocations: () => pullRevocations(true), get publicKey() { return active().pub; }, get kid() { return active().kid; }, _state: S };
}

const api = { createMarketplace, verifyDoc, verify, canon, sha, b64u, unb64u, validateSchema: validate };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Core = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
