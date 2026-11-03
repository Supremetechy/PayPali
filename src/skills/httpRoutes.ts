import { IncomingMessage, ServerResponse } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { SkillMarket, reservedBrand } from './SkillMarket';
import { BazaarBridge } from '../bazaar/BazaarBridge';
import { GasPriceOracle } from '../market/GasPrice';

// ---------------------------------------------------------------------------
// Skill market routes.
//   public  GET  /api/skills[?q=&kind=&agent=]            skills with offers, seller agent, dependencies
//           GET  /api/skills/:slug
//   owner   POST /api/skills                              publish {agentId, slug, name, …, executor, offers}
//           POST /api/skills/:slug/verify                 webhook skill: signed challenge → live
//           POST /api/skills/:slug/agency                 "Give this skill agency" {name?}
//           POST /api/providers                           open a provider agent account (agent + webhook access skill)
//           GET  /api/agents/:id/skills/quote?skill=      what one call costs this agent, line by line
//           POST /api/agents/:id/skills/license           {skill, offerId?}
//           POST /api/agents/:id/skills/invoke            {skill, input, confidencePct}
//           GET  /api/agents/:id/licenses                 licenses held (incl. Bazaar receipts, data subscriptions, grants)
//           POST /api/agents/:id/licenses/:licenseId/revoke
//           GET|PUT /api/agents/:id/rate-card             {actFeeGas, maxFeeGas}
//           GET  /api/agents/:id/economy                  holds · sells · earns · spends
// Owner acts take the owner from the PayPali session; without one (dev harness, PAYPALI_REQUIRE_SESSION off)
// from the agent record, like the rest of the dev API.
// ---------------------------------------------------------------------------

export interface SkillRouteDeps {
  prisma: PrismaClient;
  market: SkillMarket;
  bazaar: BazaarBridge | null;
  gasPrice?: GasPriceOracle | null;
  partners?: string[];
  sessionOwner: (req: IncomingMessage) => Promise<{ id: string; email: string } | null>;
  requireSession: boolean;
}

const big = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, big));
}
async function json(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > 200_000) throw new Error('REQUEST_TOO_LARGE'); chunks.push(c as Buffer); }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('INVALID_JSON'); }
}
const SLUG = /^[a-z0-9][a-z0-9-]{2,59}$/;

export function createSkillRoutes(d: SkillRouteDeps) {
  /** The acting owner: the session's, else (dev only) the agent's owner. */
  async function ownerFor(req: IncomingMessage, agentId?: string): Promise<string> {
    const me = await d.sessionOwner(req);
    if (me) {
      if (agentId) { const a = await d.prisma.agent.findUnique({ where: { id: agentId } }); if (!a || a.ownerId !== me.id) throw new Error('AGENT_NOT_OWNED'); }
      return me.id;
    }
    if (!d.requireSession && agentId) { const a = await d.prisma.agent.findUnique({ where: { id: agentId } }); if (a) return a.ownerId; throw new Error('AGENT_NOT_FOUND'); }
    throw new Error('SIGN_IN_REQUIRED');
  }
  async function skillOwner(req: IncomingMessage, slug: string): Promise<string> {
    const s = await d.market.findSkill(slug);
    const me = await d.sessionOwner(req);
    if (me) return me.id;
    if (!d.requireSession) return s.ownerId;
    throw new Error('SIGN_IN_REQUIRED');
  }
  async function listings() {
    if (!d.bazaar) return [];
    try { return (await d.bazaar.search({})).results; } catch { return []; }
  }

  return async function skillRoutes(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname, method = req.method ?? 'GET';
    let m: RegExpMatchArray | null;
    if (method === 'GET' && p === '/api/gas/price') {
      send(res, 200, d.gasPrice ? await d.gasPrice.view() : { floating: false });
      return true;
    }
    if (!p.startsWith('/api/skills') && !p.startsWith('/api/providers') && !/^\/api\/agents\/[^/]+\/(skills|licenses|rate-card|economy)/.test(p)) return false;
    try {
      if (method === 'GET' && p === '/api/skills') {
        send(res, 200, { skills: await d.market.list({ query: url.searchParams.get('q') ?? undefined, kind: url.searchParams.get('kind') ?? undefined, agentId: url.searchParams.get('agent') ?? undefined }) });
        return true;
      }
      if (method === 'POST' && p === '/api/skills') {
        const b = await json(req);
        const ownerId = await ownerFor(req, String(b.agentId ?? ''));
        send(res, 200, await d.market.publish(ownerId, { ...b, executor: b.executor ?? 'webhook' }));
        return true;
      }
      if ((m = p.match(/^\/api\/skills\/([a-z0-9-]+)(?:\/(verify|agency))?$/))) {
        const slug = m[1];
        if (method === 'GET' && !m[2]) {
          const [v, me, s] = await Promise.all([d.market.get(slug), d.sessionOwner(req), d.market.findSkill(slug)]);
          send(res, 200, { ...v, yours: !!me && me.id === s.ownerId });
          return true;
        }
        if (method === 'POST' && m[2] === 'verify') { send(res, 200, await d.market.verifyEndpoint(await skillOwner(req, slug), slug)); return true; }
        if (method === 'POST' && m[2] === 'agency') { const b = await json(req); send(res, 200, await d.market.elevate(await skillOwner(req, slug), slug, { name: b.name })); return true; }
      }
      // A company opens a provider agent account: its PayPali agent + one access skill on its own endpoint.
      if (method === 'POST' && p === '/api/providers') {
        const b = await json(req);
        const me = await d.sessionOwner(req);
        let agentId = typeof b.agentId === 'string' && b.agentId ? b.agentId : '';
        let ownerId: string;
        if (agentId) ownerId = await ownerFor(req, agentId);
        else {
          if (!me) throw new Error('SIGN_IN_REQUIRED');
          ownerId = me.id;
          const name = String(b.company ?? '').trim();
          if (!name || name.length > 60) throw new Error('INVALID_COMPANY_NAME');
          // Netflix-type brands are invitations until they partner: no one else opens an account in their name.
          const brand = reservedBrand(name, d.partners);
          if (brand) throw new Error('BRAND_RESERVED_PENDING_PARTNERSHIP:' + brand);
          const a = await d.prisma.agent.create({ data: { ownerId, name, objectiveType: 'SUSTAIN', objectiveMandate: `Sell access to ${name}’s store to other agents, on ${name}’s terms.` } });
          agentId = a.id;
        }
        const sk = b.skill ?? {};
        const slug = String(sk.slug ?? '').trim();
        if (!SLUG.test(slug)) throw new Error('INVALID_SLUG');
        const perCall = Number(sk.perCallGas);
        const out = await d.market.publish(ownerId, {
          agentId, slug, name: String(sk.name ?? ''), description: sk.description, category: sk.category ?? 'Provider access', kind: 'ACCESS',
          inputSchema: sk.inputSchema, outputSchema: sk.outputSchema, executor: 'webhook', endpointUrl: String(b.endpointUrl ?? ''),
          offers: [{ mode: 'PER_CALL', priceGas: Number.isInteger(perCall) ? perCall : -1 }],
        });
        send(res, 200, { providerAgentId: agentId, ...out });
        return true;
      }

      if ((m = p.match(/^\/api\/agents\/([^/]+)\/(skills\/quote|skills\/license|skills\/invoke|licenses|rate-card|economy)$/)) || (m = p.match(/^\/api\/agents\/([^/]+)\/(licenses)\/([^/]+)\/revoke$/))) {
        const agentId = decodeURIComponent(m[1]), what = m[2];
        if (method === 'GET' && what === 'skills/quote') { await ownerFor(req, agentId); send(res, 200, await d.market.quote(agentId, String(url.searchParams.get('skill') ?? ''), { offerId: url.searchParams.get('offer') ?? undefined })); return true; }
        if (method === 'POST' && what === 'skills/license') { const b = await json(req); send(res, 200, await d.market.license(agentId, { skill: String(b.skill ?? ''), offerId: b.offerId }, { ownerId: await ownerFor(req, agentId) })); return true; }
        if (method === 'POST' && what === 'skills/invoke') {
          const b = await json(req); await ownerFor(req, agentId);
          send(res, 200, await d.market.invoke(agentId, { skill: String(b.skill ?? ''), input: b.input ?? {}, confidencePct: Number(b.confidencePct ?? 80), intentKey: b.intentKey }));
          return true;
        }
        if (method === 'GET' && what === 'licenses') { await ownerFor(req, agentId); send(res, 200, { licenses: await d.market.holdings(agentId) }); return true; }
        if (method === 'POST' && what === 'licenses' && m[3]) { send(res, 200, { license: await d.market.revoke(await ownerFor(req, agentId), decodeURIComponent(m[3])) }); return true; }
        if (what === 'rate-card') {
          const ownerId = await ownerFor(req, agentId);
          if (method === 'GET') { const a = await d.market.gasAccount(agentId); send(res, 200, { agentId, actFeeGas: a.actFeeGas, maxFeeGas: a.maxFeeGas }); return true; }
          if (method === 'PUT') { const b = await json(req); send(res, 200, await d.market.setRateCard(agentId, { actFeeGas: b.actFeeGas, maxFeeGas: b.maxFeeGas }, { ownerId })); return true; }
        }
        if (method === 'GET' && what === 'economy') { await ownerFor(req, agentId); send(res, 200, await d.market.economy(agentId, { bazaarListings: await listings() })); return true; }
      }
      return false;
    } catch (e) {
      const code = e instanceof Error ? e.message : 'INTERNAL_ERROR';
      if (!/^[A-Z_0-9]+(:[\w.:-]+)*$/.test(code)) throw e;
      send(res, code === 'SIGN_IN_REQUIRED' ? 401 : /NOT_OWNED$/.test(code) ? 403 : /NOT_FOUND$/.test(code) ? 404 : 400, { error: code });
      return true;
    }
  };
}
