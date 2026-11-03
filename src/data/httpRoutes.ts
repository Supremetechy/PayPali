import { IncomingMessage, ServerResponse } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { DataAgentService } from './DataAgentService';

// ---------------------------------------------------------------------------
// HTTP surface for company data agents.
//
//   public   GET  /api/data-agents[?q=]                         listings (question types, prices, claims, stats)
//            GET  /api/data-agents/:slug
//   company  GET  /api/owners/:ownerId/data-agents             mine, with stats
//            POST /api/owners/:ownerId/data-agents             register → endpoint secret (once)
//            PATCH/api/owners/:ownerId/data-agents/:id         name, description, endpoint, pause
//            POST /api/owners/:ownerId/data-agents/:id/verify  signed challenge → ACTIVE
//            POST /api/owners/:ownerId/data-agents/:id/rotate-secret
//            PUT  /api/owners/:ownerId/data-agents/:id/question-types   upsert one by key
//            POST /api/owners/:ownerId/data-agents/:id/splits  propose a revenue share
//            GET  /api/owners/:ownerId/data-splits             splits I pay or receive
//            POST /api/owners/:ownerId/data-splits/:id/(accept|end)
//   buyer    POST /api/agents/:agentId/data/quote
//            POST /api/agents/:agentId/data/query
//            GET  /api/agents/:agentId/data/queries/:id
//            GET|POST /api/agents/:agentId/data-subscriptions  (POST {dataAgent, monthlyBudgetMinor})
//            POST /api/owners/:ownerId/data-subscriptions/:id/cancel
//            GET  /api/owners/:ownerId/data-queries            my agents' queries
//            POST /api/owners/:ownerId/data-queries/:id/dispute
//
// /api/owners/* and /api/agents/* are behind the server's session guard
// (PAYPALI_REQUIRE_SESSION=1): only the signed-in owner can act for them.
// ---------------------------------------------------------------------------

const big = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, big));
}
async function json(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > 512_000) throw new Error('REQUEST_TOO_LARGE'); chunks.push(c as Buffer); }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('INVALID_JSON'); }
}
const minor = (v: unknown, name: string): bigint => {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d{1,15}$/.test(v)) return BigInt(v);
  throw new Error(`INVALID_${name}`);
};

export function createDataRoutes(d: { prisma: PrismaClient; data: DataAgentService }) {
  return async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname, method = req.method ?? 'GET';
    let m: RegExpMatchArray | null;
    try {
      // ---- public ----
      if (method === 'GET' && p === '/api/data-agents') { send(res, 200, { dataAgents: await d.data.list({ query: url.searchParams.get('q') ?? undefined }) }); return true; }
      if (method === 'GET' && (m = p.match(/^\/api\/data-agents\/([a-z0-9-]+)$/))) { send(res, 200, await d.data.get(m[1])); return true; }

      // ---- company ----
      if ((m = p.match(/^\/api\/owners\/([^/]+)\/data-agents(?:\/([^/]+)(?:\/(verify|rotate-secret|question-types|splits))?)?$/))) {
        const ownerId = decodeURIComponent(m[1]), id = m[2] ? decodeURIComponent(m[2]) : null, action = m[3] ?? null;
        if (!id && method === 'GET') { send(res, 200, { dataAgents: await d.data.ownedAgents(ownerId) }); return true; }
        if (!id && method === 'POST') {
          const b = await json(req);
          send(res, 201, await d.data.register(ownerId, { agentId: b.agentId, slug: b.slug, name: b.name, description: b.description, endpointUrl: b.endpointUrl, disputeWindowHours: b.disputeWindowHours }));
          return true;
        }
        if (id && !action && method === 'PATCH') { send(res, 200, await d.data.update(ownerId, id, await json(req))); return true; }
        if (id && action === 'verify' && method === 'POST') { send(res, 200, await d.data.verifyEndpoint(ownerId, id)); return true; }
        if (id && action === 'rotate-secret' && method === 'POST') { send(res, 200, await d.data.rotateSecret(ownerId, id)); return true; }
        if (id && action === 'question-types' && method === 'PUT') { send(res, 200, await d.data.upsertQuestionType(ownerId, id, await json(req))); return true; }
        if (id && action === 'splits' && method === 'POST') {
          const b = await json(req);
          send(res, 201, await d.data.proposeSplit(ownerId, id, { payeeAgentId: b.payeeAgentId, label: b.label, shareBps: b.shareBps }));
          return true;
        }
        send(res, 405, { error: 'method_not_allowed' }); return true;
      }
      if (method === 'GET' && (m = p.match(/^\/api\/owners\/([^/]+)\/data-splits$/))) { send(res, 200, { splits: await d.data.splits(decodeURIComponent(m[1])) }); return true; }
      if (method === 'POST' && (m = p.match(/^\/api\/owners\/([^/]+)\/data-splits\/([^/]+)\/(accept|end)$/))) {
        const ownerId = decodeURIComponent(m[1]), id = decodeURIComponent(m[2]);
        send(res, 200, m[3] === 'accept' ? await d.data.acceptSplit(ownerId, id) : await d.data.endSplit(ownerId, id));
        return true;
      }

      // ---- buyer ----
      if (method === 'POST' && (m = p.match(/^\/api\/agents\/([^/]+)\/data\/(quote|query)$/))) {
        const agentId = decodeURIComponent(m[1]), b = await json(req);
        if (m[2] === 'quote') send(res, 200, await d.data.quote(agentId, { dataAgent: b.dataAgent, questionType: b.questionType, purpose: b.purpose }));
        else send(res, 200, await d.data.query(agentId, { dataAgent: b.dataAgent, questionType: b.questionType, input: b.input ?? {}, purpose: b.purpose, confidencePct: b.confidencePct, idempotencyKey: b.idempotencyKey }));
        return true;
      }
      if (method === 'GET' && (m = p.match(/^\/api\/agents\/([^/]+)\/data\/queries\/([^/]+)$/))) { send(res, 200, await d.data.getQuery(decodeURIComponent(m[1]), decodeURIComponent(m[2]))); return true; }
      if ((m = p.match(/^\/api\/agents\/([^/]+)\/data-subscriptions$/))) {
        const agentId = decodeURIComponent(m[1]);
        if (method === 'POST') {
          const a = await d.prisma.agent.findUnique({ where: { id: agentId } });
          if (!a) throw new Error('AGENT_NOT_FOUND');
          const b = await json(req);
          send(res, 201, await d.data.subscribe({ ownerId: a.ownerId }, agentId, { dataAgent: String(b.dataAgent ?? ''), monthlyBudgetMinor: minor(b.monthlyBudgetMinor, 'MONTHLY_BUDGET') }));
          return true;
        }
        if (method === 'GET') { send(res, 200, { subscriptions: await d.data.subscriptions(agentId) }); return true; }
        send(res, 405, { error: 'method_not_allowed' }); return true;
      }
      if (method === 'POST' && (m = p.match(/^\/api\/owners\/([^/]+)\/data-subscriptions\/([^/]+)\/cancel$/))) {
        send(res, 200, await d.data.cancelSubscription({ ownerId: decodeURIComponent(m[1]) }, decodeURIComponent(m[2]))); return true;
      }
      if (method === 'GET' && (m = p.match(/^\/api\/owners\/([^/]+)\/data-queries$/))) { send(res, 200, { queries: await d.data.queriesForOwner(decodeURIComponent(m[1])) }); return true; }
      if (method === 'POST' && (m = p.match(/^\/api\/owners\/([^/]+)\/data-queries\/([^/]+)\/dispute$/))) {
        const b = await json(req);
        send(res, 200, await d.data.dispute(decodeURIComponent(m[1]), decodeURIComponent(m[2]), b.reason));
        return true;
      }
    } catch (e) {
      const code = e instanceof Error ? e.message : 'INTERNAL_ERROR';
      if (!/^[A-Z_0-9]+(:[\w.:-]+)*$/.test(code)) throw e;
      send(res, /NOT_FOUND$/.test(code.split(':')[0]) ? 404 : 400, { error: code });
      return true;
    }
    return false;
  };
}
