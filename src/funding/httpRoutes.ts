import { IncomingMessage, ServerResponse } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { FundingService, safePath } from './FundingService';

// ---------------------------------------------------------------------------
// HTTP for funding agents from PayPal.
//
//   GET  /api/funding/config                         provider, public client id, JS SDK url
//   POST /api/funding/seed-orders                    onboarding seed order {amountMinor, currency, saveForAllowance}
//   POST /api/agents/:id/funding/orders              owner: top-up order {amountMinor, currency, saveForAllowance, returnPath}
//   POST /api/funding/orders/:orderId/capture        capture an approved top-up / allowance order (idempotent)
//   GET  /api/funding/orders/:orderId                status of one order
//   GET  /api/agents/:id/funding                     orders, allowance, beneficiary sweep, saved PayPal
//   PUT  /api/agents/:id/allowance                   {amountMinor, period, paymentMethodId?, startNow?}
//   POST /api/agents/:id/allowance/(pause|resume|cancel)
//   PUT  /api/agents/:id/beneficiary                 {receiver, keepMinor, minPayoutMinor?, period}
//   POST /api/agents/:id/beneficiary/sweep           pay the beneficiary now (Payouts)
//   DELETE /api/owners/:ownerId/payment-methods/:id  forget a saved PayPal
//   GET  /fund/return                                PayPal's return/cancel URL
//   GET|POST /fund/dev/:orderId                      dev-only approval page (no PayPal credentials)
// ---------------------------------------------------------------------------

const big = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, big));
}
function redirect(res: ServerResponse, to: string) { res.writeHead(303, { location: to, 'cache-control': 'no-store' }); res.end(); }
async function raw(req: IncomingMessage) {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > 64_000) throw new Error('REQUEST_TOO_LARGE'); chunks.push(c as Buffer); }
  return Buffer.concat(chunks).toString('utf8');
}
async function json(req: IncomingMessage): Promise<any> {
  const r = await raw(req);
  if (!r) return {};
  try { return JSON.parse(r); } catch { throw new Error('INVALID_JSON'); }
}
const minor = (v: unknown, name: string): bigint => {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d{1,15}$/.test(v)) return BigInt(v);
  throw new Error(`INVALID_${name}`);
};
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const withParams = (path: string, params: Record<string, string>) => {
  const u = new URL(path, 'http://x');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.pathname + u.search;
};

export function createFundingRoutes(d: { prisma: PrismaClient; funding: FundingService }) {
  const ownerOf = async (agentId: string) => {
    const a = await d.prisma.agent.findUnique({ where: { id: agentId } });
    if (!a) throw new Error('AGENT_NOT_FOUND');
    return a.ownerId;
  };

  return async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname, method = req.method ?? 'GET';
    let m: RegExpMatchArray | null;
    try {
      if (method === 'GET' && p === '/api/funding/config') { send(res, 200, d.funding.config()); return true; }
      if (method === 'POST' && p === '/api/funding/seed-orders') {
        const b = await json(req);
        send(res, 200, await d.funding.createSeedOrder({ amountMinor: minor(b.amountMinor, 'AMOUNT'), currency: String(b.currency ?? 'USD'), saveForAllowance: b.saveForAllowance === true, returnPath: b.returnPath }));
        return true;
      }
      if (method === 'POST' && (m = p.match(/^\/api\/agents\/([^/]+)\/funding\/orders$/))) {
        const agentId = decodeURIComponent(m[1]), b = await json(req);
        send(res, 200, await d.funding.createTopUp(await ownerOf(agentId), agentId, { amountMinor: minor(b.amountMinor, 'AMOUNT'), currency: String(b.currency ?? 'USD'), saveForAllowance: b.saveForAllowance === true, returnPath: b.returnPath }));
        return true;
      }
      if ((m = p.match(/^\/api\/funding\/orders\/([A-Za-z0-9-]+)(\/capture)?$/))) {
        if (method === 'POST' && m[2]) { send(res, 200, await d.funding.capture(m[1])); return true; }
        if (method === 'GET' && !m[2]) { const f = await d.funding.getByOrderId(m[1]); send(res, f ? 200 : 404, f ?? { error: 'FUNDING_ORDER_NOT_FOUND' }); return true; }
      }
      if (method === 'GET' && (m = p.match(/^\/api\/agents\/([^/]+)\/funding$/))) {
        const agentId = decodeURIComponent(m[1]), ownerId = await ownerOf(agentId);
        const [orders, allowance, sweep, paymentMethods] = await Promise.all([d.funding.orders(ownerId, agentId), d.funding.getAllowance(agentId), d.funding.getSweep(agentId), d.funding.paymentMethods(ownerId)]);
        send(res, 200, { config: d.funding.config(), orders, allowance, beneficiary: sweep, paymentMethods });
        return true;
      }
      if ((m = p.match(/^\/api\/agents\/([^/]+)\/allowance(?:\/(pause|resume|cancel))?$/))) {
        const agentId = decodeURIComponent(m[1]), ownerId = await ownerOf(agentId);
        if (method === 'PUT' && !m[2]) {
          const b = await json(req);
          send(res, 200, await d.funding.setAllowance(ownerId, agentId, { amountMinor: minor(b.amountMinor, 'AMOUNT'), currency: b.currency, period: b.period, paymentMethodId: b.paymentMethodId, startNow: b.startNow }));
          return true;
        }
        if (method === 'POST' && m[2]) { send(res, 200, await d.funding.setAllowanceStatus(ownerId, agentId, m[2] === 'pause' ? 'PAUSED' : m[2] === 'resume' ? 'ACTIVE' : 'CANCELLED')); return true; }
      }
      if ((m = p.match(/^\/api\/agents\/([^/]+)\/beneficiary(\/sweep)?$/))) {
        const agentId = decodeURIComponent(m[1]), ownerId = await ownerOf(agentId);
        if (method === 'PUT' && !m[2]) {
          const b = await json(req);
          send(res, 200, await d.funding.setSweep(ownerId, agentId, { receiver: b.receiver, keepMinor: minor(b.keepMinor ?? 0, 'KEEP'), minPayoutMinor: b.minPayoutMinor !== undefined ? minor(b.minPayoutMinor, 'MIN_PAYOUT') : undefined, period: b.period ?? 'MANUAL' }));
          return true;
        }
        if (method === 'POST' && m[2]) { send(res, 200, await d.funding.sweepNow(ownerId, agentId)); return true; }
      }
      if (method === 'DELETE' && (m = p.match(/^\/api\/owners\/([^/]+)\/payment-methods\/([^/]+)$/))) {
        send(res, 200, await d.funding.removePaymentMethod(decodeURIComponent(m[1]), decodeURIComponent(m[2]))); return true;
      }

      // ---- PayPal's return / cancel ----
      if (method === 'GET' && p === '/fund/return') {
        const fid = url.searchParams.get('f') ?? '';
        const next = safePath(url.searchParams.get('next')) ?? '/dashboard';
        const f = await d.funding.getFunding(fid);
        if (!f) { redirect(res, withParams(next, { funding: 'unknown' })); return true; }
        if (url.searchParams.get('cancel')) { await d.funding.cancel(fid); redirect(res, withParams(next, { funding: 'cancelled' })); return true; }
        if (f.purpose === 'SEED') { redirect(res, withParams(next, { seedOrder: f.orderId })); return true; }
        const r: any = await d.funding.capture(f.orderId);
        redirect(res, withParams(next, { funding: r.pending ? 'pending' : String(r.status).toLowerCase(), ...(r.agentId ? { agent: r.agentId } : {}) }));
        return true;
      }

      // ---- dev approval page ----
      if ((m = p.match(/^\/fund\/dev\/([A-Z0-9]+)$/))) {
        const dev = d.funding.dev;
        if (!dev) { send(res, 404, { error: 'NOT_FOUND' }); return true; }
        const o = dev.orders.get(m[1]);
        if (method === 'POST') {
          const form = new URLSearchParams(await raw(req));
          const to = dev.decide(m[1], form.get('decision') === 'approve');
          if (!to) { send(res, 409, { error: 'ORDER_NOT_APPROVABLE' }); return true; }
          redirect(res, to); return true;
        }
        if (!o) { send(res, 404, { error: 'ORDER_NOT_FOUND' }); return true; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(devPage(m[1], o.amountMinor, o.currency, o.description, o.save, o.state));
        return true;
      }
    } catch (e) {
      const code = e instanceof Error ? e.message : 'INTERNAL_ERROR';
      if (!/^[A-Z_0-9]+(:[\w.:-]+)*$/.test(code)) throw e;
      send(res, /NOT_FOUND|NOT_OWNED$/.test(code) ? 404 : 400, { error: code });
      return true;
    }
    return false;
  };
}

function devPage(orderId: string, amountMinor: bigint, currency: string, description: string, save: boolean, state: string) {
  const amt = `$${(Number(amountMinor) / 100).toFixed(2)} ${esc(currency)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve payment (dev)</title>
<style>:root{color-scheme:light dark;--bg:#f5f7fa;--card:#fff;--ink:#11264f;--soft:#4a5873;--accent:#0070e0;--warn:#fff4d6}
@media (prefers-color-scheme:dark){:root{--bg:#0a1230;--card:#10193c;--ink:#e8edf8;--soft:#a9b6d4;--accent:#2b8fff;--warn:#3a2f10}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
.c{background:var(--card);border-radius:16px;padding:24px;max-width:420px;width:100%;box-shadow:0 18px 40px -22px rgba(0,28,100,.4)}
h1{font-size:1.3rem;margin:0 0 4px}.amt{font-size:2rem;font-weight:800;margin:12px 0}.soft{color:var(--soft);font-size:.92rem}
.w{background:var(--warn);border-radius:10px;padding:10px 12px;font-size:.88rem;margin:14px 0}
button{font:inherit;font-weight:700;border-radius:999px;padding:11px 18px;border:0;cursor:pointer;width:100%;margin-top:10px}
.a{background:var(--accent);color:#fff}.x{background:transparent;color:var(--ink);border:1.5px solid var(--soft)}</style></head>
<body><form class="c" method="post"><h1>Approve payment</h1><div class="soft">${esc(description)}</div><div class="amt">${amt}</div>
${save ? '<p class="soft">Also save this PayPal account so PayPali can charge allowances without asking each time.</p>' : ''}
<div class="w"><b>Development mode.</b> PayPal isn't configured on this server (no PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET), so this page stands in for PayPal's approval screen. No real money moves.</div>
${state === 'CREATED' ? '<button class="a" name="decision" value="approve">Approve and pay</button><button class="x" name="decision" value="cancel">Cancel</button>' : `<p>This order is already ${esc(state.toLowerCase())}.</p>`}
<p class="soft">Order ${esc(orderId)}</p></form></body></html>`;
}
