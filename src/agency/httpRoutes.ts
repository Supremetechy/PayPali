import { IncomingMessage, ServerResponse } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { AgencyService } from './AgencyService';

// ---------------------------------------------------------------------------
//   GET  /api/agents/:id/power-of-agency          active version, history, the draft of the next one
//   POST /api/agents/:id/power-of-agency/sign     owner accepts {acceptedTermsSha256, termDays?}
//   POST /api/power-of-agency/verify              anyone: check a document {body, sig}
//   POST /api/agents/:id/stop                     kill switch {reason}
//   POST /api/agents/:id/resume
//   GET  /api/agents/:id/stops                    kill-switch history
// /api/agents/* is behind the server's session guard (PAYPALI_REQUIRE_SESSION=1).
// ---------------------------------------------------------------------------

const big = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, big));
}
async function json(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > 64_000) throw new Error('REQUEST_TOO_LARGE'); chunks.push(c as Buffer); }
  const r = Buffer.concat(chunks).toString('utf8');
  if (!r) return {};
  try { return JSON.parse(r); } catch { throw new Error('INVALID_JSON'); }
}

export function createAgencyRoutes(d: { prisma: PrismaClient; agency: AgencyService; enforced: boolean }) {
  const ownerOf = async (agentId: string) => {
    const a = await d.prisma.agent.findUnique({ where: { id: agentId } });
    if (!a) throw new Error('AGENT_NOT_FOUND');
    return a.ownerId;
  };
  return async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname, method = req.method ?? 'GET';
    let m: RegExpMatchArray | null;
    try {
      if (method === 'POST' && p === '/api/power-of-agency/verify') { const b = await json(req); send(res, 200, await d.agency.verify(b.document ?? b)); return true; }
      if ((m = p.match(/^\/api\/agents\/([^/]+)\/power-of-agency(\/sign)?$/))) {
        const agentId = decodeURIComponent(m[1]), ownerId = await ownerOf(agentId);
        if (method === 'GET' && !m[2]) {
          const [cur, draft, diff] = await Promise.all([d.agency.current(agentId), d.agency.draft(ownerId, agentId), d.agency.changedSinceSigned(ownerId, agentId)]);
          send(res, 200, { enforced: d.enforced, ...cur, draft, draftTermsSha256: diff.draftTermsSha256, changedSinceSigned: diff.changed });
          return true;
        }
        if (method === 'POST' && m[2]) { const b = await json(req); send(res, 200, await d.agency.sign(ownerId, agentId, { acceptedTermsSha256: b.acceptedTermsSha256, termDays: b.termDays })); return true; }
      }
      if (method === 'POST' && (m = p.match(/^\/api\/agents\/([^/]+)\/(stop|resume)$/))) {
        const agentId = decodeURIComponent(m[1]), ownerId = await ownerOf(agentId), b = await json(req);
        send(res, 200, m[2] === 'stop' ? await d.agency.stop(ownerId, agentId, b.reason) : await d.agency.resume(ownerId, agentId, b.reason));
        return true;
      }
      if (method === 'GET' && (m = p.match(/^\/api\/agents\/([^/]+)\/stops$/))) { send(res, 200, { events: await d.agency.stopHistory(decodeURIComponent(m[1])) }); return true; }
    } catch (e) {
      const code = e instanceof Error ? e.message : 'INTERNAL_ERROR';
      if (!/^[A-Z_0-9]+(:[\w.:-]+)*$/.test(code)) throw e;
      send(res, /NOT_FOUND|NOT_OWNED$/.test(code) ? 404 : 400, { error: code });
      return true;
    }
    return false;
  };
}
