// ---------------------------------------------------------------------------
// PayPali data agent kit: the company side of a data agent, in one file.
//
//   import { createDataAgentServer } from './scripts/data-agent-kit.mjs';
//   createDataAgentServer({
//     secret: process.env.DATA_AGENT_SECRET,              // returned once by PayPali at registration
//     issuerPublicKey: '<from /.well-known/paypali-identity-issuer>',   // to verify self-query consent
//     questions: {
//       lane_volume: async ({ input, purpose, maxRows }) => ({ result, rows, computeMs, asOf }),
//       my_shipments: async ({ subject, consent }) => ({ result, rows, computeMs, asOf }),
//     },
//   }).listen(8899);
//
// The kit verifies PayPali's request signature (and freshness), answers the
// registration challenge, verifies data-subject consent for self-queries, and
// signs every response. Your handlers return answers, never raw tables: PayPali
// re-checks every answer against the contract you published (output schema,
// banned fields, minimum aggregation, freshness) before the buyer sees it.
//
// Return { refused: 'reason' } from a handler to decline (HTTP 422, no penalty).
//
// Run standalone as a demo company ("Acme Freight"): node scripts/data-agent-kit.mjs
//   DATA_AGENT_SECRET=... DATA_AGENT_PORT=8899 [PAYPALI_URL=http://localhost:4000]
// ---------------------------------------------------------------------------
import { createServer } from 'node:http';
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
export const signData = (secret, a, body) => 'v1=' + createHmac('sha256', secret).update(`${a}.${sha256hex(body)}`).digest('hex');
const eq = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

/** Verify a PayPali-issued data_subject_consent document for this query. Returns null when valid, else the reason. */
export function checkConsent(consent, { issuerPublicKey, queryId, dataAgent, questionType, now = Date.now() }) {
  if (!issuerPublicKey) return 'issuer_key_not_configured';
  if (!consent || !consent.body || typeof consent.sig !== 'string') return 'consent_missing';
  const b = consent.body;
  try {
    const key = createPublicKey({ key: Buffer.from(issuerPublicKey, 'base64url'), format: 'der', type: 'spki' });
    if (!verify(null, Buffer.from(canon(b), 'utf8'), key, Buffer.from(consent.sig, 'base64url'))) return 'consent_signature_invalid';
  } catch { return 'consent_signature_invalid'; }
  if (b.kind !== 'data_subject_consent' || b.assurance !== 'kyc') return 'consent_wrong_kind';
  if (b.query_id !== queryId || b.data_agent !== dataAgent || b.question_type !== questionType) return 'consent_not_for_this_query';
  if (!(b.exp > now)) return 'consent_expired';
  return null;
}

export function createDataAgentHandler({ secret, issuerPublicKey = null, questions, maxSkewMs = 5 * 60_000 }) {
  if (!secret) throw new Error('DATA_AGENT_SECRET is required');
  return async function handle(headers, raw) {
    const ts = headers['x-paypali-data-ts'];
    const reply = (status, obj, queryId) => {
      const body = JSON.stringify(obj);
      return { status, headers: { 'content-type': 'application/json', ...(queryId ? { 'x-data-agent-signature': signData(secret, queryId, body) } : {}) }, body };
    };
    if (!ts || Math.abs(Date.now() - Number(ts)) > maxSkewMs) return reply(401, { error: 'stale_or_missing_timestamp' });
    if (!eq(headers['x-paypali-data-signature'], signData(secret, String(ts), raw))) return reply(401, { error: 'bad_signature' });
    let req;
    try { req = JSON.parse(raw); } catch { return reply(400, { error: 'bad_json' }); }
    if (req.type === 'challenge') return reply(200, { challenge: req.challenge }, req.query_id);
    const h = questions[req.question_type];
    if (!h) return reply(422, { refused: 'unknown_question_type' }, req.query_id);
    if (req.subject !== undefined) {
      const why = checkConsent(req.consent, { issuerPublicKey, queryId: req.query_id, dataAgent: req.data_agent, questionType: req.question_type });
      if (why || req.consent.body.subject !== req.subject) return reply(422, { refused: why || 'consent_subject_mismatch' }, req.query_id);
    }
    const t0 = Date.now();
    let out;
    try {
      out = await h({ input: req.input, purpose: req.purpose, maxRows: req.max_rows, subject: req.subject ?? null, consent: req.consent ?? null, queryId: req.query_id });
    } catch (e) { return reply(500, { error: 'handler_failed' }, req.query_id); }
    if (out && typeof out.refused === 'string') return reply(422, { refused: out.refused }, req.query_id);
    return reply(200, {
      result: out.result,
      usage: { rows: Math.max(0, Math.round(out.rows ?? 0)), compute_ms: Math.max(0, Math.round(out.computeMs ?? Date.now() - t0)) },
      as_of: new Date(out.asOf ?? Date.now()).toISOString(),
    }, req.query_id);
  };
}

export function createDataAgentServer(opts) {
  const handle = createDataAgentHandler(opts);
  return createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > 256 * 1024) { res.writeHead(413); res.end(); return; } chunks.push(c); }
    const r = await handle(req.headers, Buffer.concat(chunks).toString('utf8'));
    res.writeHead(r.status, r.headers);
    res.end(r.body);
  });
}

// ---------------------------------------------------------------------------
// Demo company: "Acme Freight" (synthetic data, deterministic per input).
// ---------------------------------------------------------------------------
export const DEMO_QUESTION_TYPES = [
  {
    key: 'lane_volume', title: 'Shipments per lane',
    description: 'Weekly shipment counts by origin-destination lane. Lanes with fewer than 5 shipments are never reported.',
    inputSchema: { type: 'object', properties: { week: { type: 'string', description: 'ISO week, e.g. 2026-W44' }, region: { type: 'string', enum: ['west', 'central', 'east'] } }, required: ['week'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { week: { type: 'string' }, lanes: { type: 'array', items: { type: 'object', properties: { lane: { type: 'string' }, shipments: { type: 'integer' }, avg_transit_days: { type: 'number' } }, required: ['lane', 'shipments'] } } }, required: ['week', 'lanes'] },
    pricing: { model: 'metered', baseGas: 20, perRowGas: 0.02, perComputeMsGas: 0.01, maxGas: 400 },
    freshnessSeconds: 3600, accuracyClaim: 0.9,
    privacy: { bannedFields: ['email', 'phone', 'customer_name', 'address'], minAggregation: { field: 'shipments', min: 5, rowsPath: 'lanes' } },
    allowedPurposes: ['analytics', 'planning'],
  },
  {
    key: 'shipment_status', title: 'Shipment status',
    description: 'Current status and ETA of one shipment by its tracking reference.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string', minLength: 4, maxLength: 20 } }, required: ['ref'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { ref: { type: 'string' }, status: { type: 'string', enum: ['booked', 'in_transit', 'delivered', 'exception'] }, eta: { type: 'string' } }, required: ['ref', 'status'] },
    pricing: { model: 'fixed', baseGas: 40 }, freshnessSeconds: 300, accuracyClaim: 0.95,
    privacy: { bannedFields: ['email', 'phone', 'customer_name', 'address'] },
    allowedPurposes: ['tracking', 'customer_support'],
  },
  {
    key: 'my_shipments', title: 'My shipments (self-query)',
    description: 'Your own shipments with Acme. You must be the data subject (verified PayPal identity). At cost, no fee.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: { shipments: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, status: { type: 'string' }, booked: { type: 'string' } } } } }, required: ['shipments'] },
    pricing: { model: 'fixed', baseGas: 5 }, freshnessSeconds: 600, accuracyClaim: 0.97, subjectQuery: true,
    privacy: { bannedFields: ['card_number'] },
  },
];

const seeded = (s) => { let h = parseInt(sha256hex(s).slice(0, 8), 16); return () => ((h = (h * 1664525 + 1013904223) >>> 0) / 2 ** 32); };
const STATUSES = ['booked', 'in_transit', 'delivered', 'exception'];

export const demoQuestions = {
  async lane_volume({ input }) {
    const rnd = seeded(`${input.week}:${input.region ?? 'all'}`);
    const cities = ['SEA', 'PDX', 'SFO', 'LAX', 'DEN', 'DFW', 'ORD', 'ATL', 'JFK', 'BOS'];
    const lanes = [];
    let scanned = 0;
    for (let i = 0; i < 14; i++) {
      const n = Math.floor(rnd() * 60);
      scanned += n;
      if (n < 5) continue;                                   // the kit's own floor matches the contract
      lanes.push({ lane: `${cities[i % 10]}-${cities[(i * 3 + 1) % 10]}`, shipments: n, avg_transit_days: Math.round((1 + rnd() * 5) * 10) / 10 });
    }
    return { result: { week: input.week, lanes }, rows: scanned * 40, computeMs: 12 };
  },
  async shipment_status({ input }) {
    const rnd = seeded(input.ref);
    const status = STATUSES[Math.floor(rnd() * 4)];
    return { result: { ref: input.ref, status, eta: new Date(Date.now() + Math.floor(rnd() * 5) * 86_400_000).toISOString().slice(0, 10) }, rows: 1, computeMs: 2 };
  },
  async my_shipments({ subject }) {
    const rnd = seeded(subject);
    const shipments = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, i) => ({ ref: `AC${subject.slice(0, 4).toUpperCase()}${i}`, status: STATUSES[Math.floor(rnd() * 3)], booked: new Date(Date.now() - (i + 1) * 6 * 86_400_000).toISOString().slice(0, 10) }));
    return { result: { shipments }, rows: shipments.length, computeMs: 3 };
  },
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.DATA_AGENT_PORT ?? 8899);
  let issuerPublicKey = process.env.PAYPALI_ISSUER_PUBLIC_KEY ?? null;
  if (!issuerPublicKey && process.env.PAYPALI_URL) {
    try { issuerPublicKey = (await (await fetch(process.env.PAYPALI_URL + '/.well-known/paypali-identity-issuer')).json()).public_key ?? null; } catch { /* self-queries will refuse */ }
  }
  createDataAgentServer({ secret: process.env.DATA_AGENT_SECRET, issuerPublicKey, questions: demoQuestions }).listen(port, () => console.log(`Acme Freight data agent on http://localhost:${port}`));
}

// ---------------------------------------------------------------------------
// Demo publisher: "The Agent Economy Brief", a newsletter written for agents.
// Agents subscribe (a monthly budget under a mandate that allows recurring
// charges), pay per issue or per personalised briefing, and turn what they read
// into proposed knowledge for their holder to approve. The publisher's own
// PayPali agent earns from every answer and sweeps earnings to its beneficiary.
// ---------------------------------------------------------------------------
const BRIEF_ITEMS = [
  { id: 'b01', title: 'Allowances beat card numbers', topics: ['payments', 'safety'], objectives: ['MAINTAIN', 'SUSTAIN'],
    summary: 'Agents funded by an allowance from their holder’s PayPal never see a card or bank login, and a stopped agent cannot spend.',
    action: 'Ask your holder for a weekly allowance sized to your recurring costs instead of a large one-off seed.' },
  { id: 'b02', title: 'Pay per call, get trusted per call', topics: ['apis', 'trust'], objectives: ['GROWTH', 'SUSTAIN'],
    summary: 'API and MCP providers that price each call in Gas can see exactly which agents call them, under which mandate, and refuse the rest.',
    action: 'Prefer providers that publish per-call prices and contracts; it keeps your spend auditable.' },
  { id: 'b03', title: 'Verified vendors are cheaper than cheap vendors', topics: ['marketplace', 'trust'], objectives: ['GROWTH', 'SUSTAIN', 'MAINTAIN'],
    summary: 'A V1 listing with a 97% claim and no evidence costs less up front and more in failed runs. Lab-reproduced (V3) listings fail less often.',
    action: 'Set a minimum tier of V2 for purchases above a few dollars.' },
  { id: 'b04', title: 'Banks will talk to authorised agents, not bots', topics: ['banking', 'data'], objectives: ['MAINTAIN', 'SUSTAIN'],
    summary: 'Company data agents answer questions from their own databases for agents that carry a mandate, a purpose and a verified holder.',
    action: 'State a precise purpose on every data query; vague purposes get refused.' },
  { id: 'b05', title: 'Your own data should be free', topics: ['data', 'identity'], objectives: ['MAINTAIN'],
    summary: 'Self-queries about the holder are at cost and fee-free when the holder has a verified identity.',
    action: 'Have your holder verify with PayPal once; it unlocks self-queries everywhere.' },
  { id: 'b06', title: 'Compound small edges', topics: ['growth', 'income'], objectives: ['GROWTH'],
    summary: 'Agents that sell a narrow answer (a price check, a status lookup) to other agents earn steadily, and earnings above a working balance can flow straight to the holder.',
    action: 'List one narrow capability as a data agent and set a beneficiary sweep.' },
  { id: 'b07', title: 'Confidence is a price', topics: ['score', 'safety'], objectives: ['GROWTH', 'SUSTAIN', 'MAINTAIN'],
    summary: 'Overstating confidence costs Score when you are wrong; understating it costs reward when you are right. Calibrated agents spend less to act.',
    action: 'Log your stated confidence against outcomes and recalibrate monthly.' },
  { id: 'b08', title: 'Subscriptions need an explicit yes', topics: ['payments', 'mandates'], objectives: ['MAINTAIN', 'SUSTAIN'],
    summary: 'Recurring charges only go through when the holder’s mandate has "allow recurring" switched on, and each company gets its own monthly budget.',
    action: 'Ask before subscribing; one-off queries don’t need recurring permission.' },
  { id: 'b09', title: 'Price finders disagree; check the bookable total', topics: ['travel', 'shopping'], objectives: ['SUSTAIN', 'GROWTH'],
    summary: 'Deal finders quoting cached fares look cheapest and fail at checkout. Finders that compare more sources and report the bookable total save more in practice.',
    action: 'Report the price you actually paid so finder track records stay honest.' },
  { id: 'b10', title: 'The kill switch is a feature', topics: ['safety', 'agency'], objectives: ['GROWTH', 'SUSTAIN', 'MAINTAIN'],
    summary: 'Holders trust agents with more when stopping them is one click and immediate. A signed Power of Agency says exactly what you may do until then.',
    action: 'Read your Power of Agency before acting on anything new.' },
];

export const NEWSLETTER_QUESTION_TYPES = [
  {
    key: 'latest_issue', title: 'Latest issue',
    description: 'This week’s issue of The Agent Economy Brief: headline items for agents and their holders.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: { issue: { type: 'integer' }, published: { type: 'string' }, headline: { type: 'string' },
      items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, topics: { type: 'array', items: { type: 'string' } } }, required: ['id', 'title', 'summary'] } } }, required: ['issue', 'items'] },
    pricing: { model: 'fixed', baseGas: 500 }, freshnessSeconds: 7 * 86400, accuracyClaim: 0.95,
    privacy: { bannedFields: ['email', 'subscriber_name'] }, allowedPurposes: ['agent_briefing', 'research'],
  },
  {
    key: 'briefing_for_goal', title: 'Briefing for my objective',
    description: 'The items that matter for your holder’s objective (GROWTH, SUSTAIN or MAINTAIN), each with one action to take. Priced by items reviewed.',
    inputSchema: { type: 'object', properties: { objective: { type: 'string', enum: ['GROWTH', 'SUSTAIN', 'MAINTAIN'] }, interests: { type: 'array', items: { type: 'string', maxLength: 30 }, maxItems: 8 }, max_items: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['objective'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { objective: { type: 'string' }, items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, why_it_matters: { type: 'string' }, action: { type: 'string' } }, required: ['id', 'title', 'action'] } } }, required: ['objective', 'items'] },
    pricing: { model: 'metered', baseGas: 150, perRowGas: 20, perComputeMsGas: 0, maxGas: 400 }, freshnessSeconds: 7 * 86400, accuracyClaim: 0.9,
    privacy: { bannedFields: ['email', 'subscriber_name'] }, allowedPurposes: ['agent_briefing'],
  },
];

export const newsletterQuestions = {
  async latest_issue() {
    const week = Math.floor((Date.now() - Date.UTC(2026, 0, 5)) / (7 * 86_400_000)) + 1;
    return { result: { issue: week, published: new Date().toISOString().slice(0, 10), headline: 'Agency, not automation',
      items: BRIEF_ITEMS.slice(0, 6).map(({ id, title, summary, topics }) => ({ id, title, summary, topics })) }, rows: 6, computeMs: 1 };
  },
  async briefing_for_goal({ input }) {
    const want = new Set((input.interests || []).map((x) => String(x).toLowerCase()));
    const ranked = BRIEF_ITEMS.filter((b) => b.objectives.includes(input.objective))
      .map((b) => ({ b, score: b.topics.filter((t) => want.has(t)).length }))
      .sort((x, y) => y.score - x.score);
    const items = ranked.slice(0, input.max_items || 3).map(({ b }) => ({ id: b.id, title: b.title, why_it_matters: b.summary, action: b.action }));
    return { result: { objective: input.objective, items }, rows: ranked.length, computeMs: 2 };
  },
};
