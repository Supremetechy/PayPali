import { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
type Owner = { id: string; email: string };
import { LinkRole, StorefrontLinkService, isEd25519Pub } from './StorefrontLink';

// ---------------------------------------------------------------------------
// Connect PayPali, the handoff the Solutions Farm storefront (AgentBazaar :8787) opens in a popup:
//
//   GET  /bazaar/link?role=buy|sell&pub=<storefront key>&state=<nonce>&origin=<storefront origin>[&budget=<$>]
//        owner signs in (PayPali session), picks the agent that pays (buy) or gets paid (sell)
//   POST /bazaar/link   performs the link and hands the result back to the storefront window with
//        postMessage, addressed ONLY to the configured Solutions Farm origin.
//
//   GET  /api/bazaar/links             the owner's storefront links (Marketplace)
//   POST /api/bazaar/links/:id/revoke  revoke one (buy: grant revoked; sell: payouts stop)
// ---------------------------------------------------------------------------

export interface LinkRouteDeps {
  prisma: PrismaClient;
  links: StorefrontLinkService;
  sessionOwner: (req: IncomingMessage) => Promise<Owner | null>;
  publicUrl: string;
  /** Public URL of the Solutions Farm storefront (AGENTBAZAAR_PUBLIC_URL, else AGENTBAZAAR_URL). */
  bazaarPublicUrl: string | null;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** The storefront origins a link result may be posted to. Loopback hosts are interchangeable in development. */
export function storefrontOrigins(bazaarPublicUrl: string | null): string[] {
  if (!bazaarPublicUrl) return [];
  let o: string; try { o = new URL(bazaarPublicUrl).origin; } catch { return []; }
  if (!LOOPBACK.test(o)) return [o];
  const port = new URL(o).port;
  return ['localhost', '127.0.0.1', '[::1]'].map((h) => `http://${h}${port ? ':' + port : ''}`);
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > 50_000) throw new Error('REQUEST_TOO_LARGE'); chunks.push(c as Buffer); }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

function page(res: ServerResponse, status: number, title: string, body: string, nonce?: string) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'${nonce ? `; script-src 'nonce-${nonce}'` : ''}`,
  });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`);
}

const CSS = `:root{--bg:#f4f6f3;--card:#fff;--ink:#14201b;--mute:#5d6b64;--line:#d9e0da;--acc:#1f7a5c;--bad:#b3392b}
@media(prefers-color-scheme:dark){:root{--bg:#0e1512;--card:#152019;--ink:#e6efe9;--mute:#93a59b;--line:#27352d;--acc:#4fc79c;--bad:#ef7d6d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:520px;margin:0 auto;padding:24px 16px 40px}h1{font-size:1.35rem;margin:0 0 4px}.sub{color:var(--mute);margin:0 0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
label{display:block;font-weight:600;font-size:.86rem;margin:10px 0 4px}input,select{width:100%;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
ul{margin:6px 0 0;padding-left:18px}li{margin:3px 0}.hint{color:var(--mute);font-size:.8rem;margin:6px 0 0}.err{color:var(--bad);font-weight:600}.ok{color:var(--acc);font-weight:600}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem;word-break:break-all}
.actions{display:flex;gap:10px;margin-top:8px;flex-wrap:wrap}button,a.btn{font:inherit;font-weight:600;border-radius:8px;padding:10px 16px;border:1px solid var(--ink);background:var(--ink);color:var(--bg);cursor:pointer;text-decoration:none}
button.ghost{background:transparent;color:var(--ink);border-color:var(--line)}`;

export function createStorefrontLinkRoutes(d: LinkRouteDeps) {
  const secret = randomBytes(32);
  const allowed = storefrontOrigins(d.bazaarPublicUrl);
  const ownOrigin = new URL(d.publicUrl).origin;
  const sign = (parts: string[]) => createHmac('sha256', secret).update(parts.join('\n')).digest('base64url');
  const tokenOk = (t: string, parts: string[]) => { const a = Buffer.from(t || ''), b = Buffer.from(sign(parts)); return a.length === b.length && timingSafeEqual(a, b); };
  const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  };

  type Req = { role: LinkRole; pub: string; state: string; origin: string; budget: string };
  function parse(q: Record<string, string | null>): Req | string {
    const role = String(q.role ?? '').toUpperCase();
    if (role !== 'BUY' && role !== 'SELL') return 'role must be buy or sell';
    if (!isEd25519Pub(q.pub)) return 'the storefront did not send a valid Ed25519 key';
    const state = String(q.state ?? '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(state)) return 'missing state';
    const origin = String(q.origin ?? '');
    if (!allowed.includes(origin)) return allowed.length ? `this page only links the Solutions Farm at ${allowed[0]}` : 'the Solutions Farm is not configured on this PayPali server (AGENTBAZAAR_URL)';
    const budget = /^\d{1,5}(\.\d{1,2})?$/.test(String(q.budget ?? '')) ? String(q.budget) : '100';
    return { role, pub: q.pub as string, state, origin, budget };
  }

  async function form(res: ServerResponse, owner: Owner, r: Req, error?: string) {
    const agents = await d.prisma.agent.findMany({ where: { ownerId: owner.id, isActive: true }, orderBy: { createdAt: 'desc' } });
    const buy = r.role === 'BUY';
    const title = buy ? 'Pay for Solutions Farm purchases' : 'Sell on the Solutions Farm';
    if (!agents.length) {
      return page(res, 200, title, `<h1>${title}</h1><div class="card"><p>Your PayPali account has no active agents yet.</p><div class="actions"><a class="btn" href="/" target="_blank" rel="noopener">Create an agent</a></div><p class="hint">Then come back to the Solutions Farm and press Connect PayPali again.</p></div>`);
    }
    const token = sign([owner.id, r.role, r.pub, r.state, r.origin]);
    const hidden = Object.entries({ role: r.role, pub: r.pub, state: r.state, origin: r.origin, token }).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('');
    page(res, error ? 400 : 200, title, `<h1>${title}</h1>
<p class="sub">${buy ? 'The Solutions Farm tab will buy with your PayPali agent’s wallet, inside the budget you set here.' : 'Your vendor key on the Solutions Farm will be verified by PayPali, and sales are paid into the agent you pick.'}</p>
${error ? `<div class="card err">Not linked: ${esc(error)}</div>` : ''}
<form method="post" action="/bazaar/link" class="card">${hidden}
  <label for="agent">${buy ? 'Agent that pays' : 'Agent that receives payouts'}</label>
  <select id="agent" name="agentId">${agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select>
  ${buy ? `<label for="budget">Budget for this storefront ($)</label><input id="budget" name="budget" type="number" min="1" max="10000" step="0.01" value="${esc(r.budget)}" required>` : ''}
  <p class="hint">Storefront key <span class="mono">…${esc(r.pub.slice(-16))}</span> from ${esc(r.origin)}</p>
  <strong style="display:block;margin-top:12px">${buy ? 'This will' : 'This will'}</strong>
  <ul>${buy ? `<li>give the agent the <b>bazaar.purchase</b> capability (each purchase still passes its Score gate)</li>
    <li>issue a 30-day grant that only this storefront key can spend, up to the budget</li>
    <li>vouch for the key, so your confirmations count as evidence</li>`
      : `<li>vouch for the vendor key (identity credential)</li><li>sign a payout binding: 90% of each sale is paid into the agent</li>`}</ul>
  <div class="actions"><button name="decision" value="approve">${buy ? 'Link and fund' : 'Link vendor'}</button><button class="ghost" name="decision" value="deny">Cancel</button></div>
  <p class="hint">Signed in as ${esc(owner.email)}. You can revoke this link in the Marketplace at any time.</p>
</form>`);
  }

  function handBack(res: ServerResponse, r: { state: string; origin: string }, msg: Record<string, unknown>, html: string) {
    const nonce = randomBytes(12).toString('base64');
    const data = JSON.stringify({ type: 'paypali-link', state: r.state, ...msg }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).replace(/</g, '\\u003c');
    page(res, 200, 'PayPali', `${html}
<div class="actions"><button class="ghost" id="close" type="button">Close this window</button></div>
<script nonce="${nonce}">(function(){var d=${data},o=${JSON.stringify(r.origin)},sent=false;
try{if(window.opener){window.opener.postMessage(d,o);sent=true}}catch(e){}
document.getElementById("close").onclick=function(){window.close()};
if(sent)setTimeout(function(){window.close()},1500);else document.getElementById("note").textContent="The Solutions Farm window is gone. Go back to it and press Connect PayPali again.";})();</script>`, nonce);
  }

  return async function storefrontLinkRoutes(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname, method = req.method ?? 'GET';
    if (p === '/bazaar/link' && method === 'GET') {
      const r = parse(Object.fromEntries(url.searchParams));
      if (typeof r === 'string') { page(res, 400, 'PayPali', `<h1>This link request is not valid</h1><div class="card err">${esc(r)}</div>`); return true; }
      const owner = await d.sessionOwner(req);
      if (!owner) { res.writeHead(303, { location: '/login?next=' + encodeURIComponent(p + url.search), 'cache-control': 'no-store' }); res.end(); return true; }
      await form(res, owner, r);
      return true;
    }
    if (p === '/bazaar/link' && method === 'POST') {
      // Same-origin form posts only (localhost and 127.0.0.1 share a site, so SameSite alone is not enough), plus a token bound to what was shown.
      const origin = String(req.headers.origin ?? '');
      if (origin !== ownOrigin && origin !== `http://${req.headers.host}`) { page(res, 403, 'PayPali', '<h1>Refused</h1><div class="card err">This form must be submitted from PayPali.</div>'); return true; }
      const f = await readForm(req);
      const r = parse(f);
      if (typeof r === 'string') { page(res, 400, 'PayPali', `<h1>This link request is not valid</h1><div class="card err">${esc(r)}</div>`); return true; }
      const owner = await d.sessionOwner(req);
      if (!owner) { page(res, 401, 'PayPali', '<h1>Sign in first</h1><div class="card err">Your PayPali session ended. Go back to the Solutions Farm and press Connect PayPali again.</div>'); return true; }
      if (!tokenOk(f.token, [owner.id, r.role, r.pub, r.state, r.origin])) { page(res, 403, 'PayPali', '<h1>Refused</h1><div class="card err">This form has expired. Start again from the Solutions Farm.</div>'); return true; }
      if (f.decision !== 'approve') {
        handBack(res, r, { role: r.role.toLowerCase(), cancelled: true }, '<h1>Nothing linked</h1><p class="sub" id="note">Returning to the Solutions Farm…</p>');
        return true;
      }
      const budgetMinor = r.role === 'BUY' ? BigInt(Math.round(Number(f.budget || r.budget) * 100)) : undefined;
      try {
        const out = await d.links.link(owner.id, { role: r.role, agentId: String(f.agentId ?? ''), pub: r.pub, budgetMinor });
        const msg = r.role === 'BUY'
          ? { role: 'buy', linkId: out.link.id, agent: out.agent, grantId: out.grant!.grantId, budgetMinor: out.grant!.maxMinor, expiresAt: out.grant!.expiresAt, credential: out.credential, marketplaceUrl: d.publicUrl + '/marketplace' }
          : { role: 'sell', linkId: out.link.id, agent: out.agent, vendorId: out.link.vendorId, credential: out.credential, binding: out.binding, marketplaceUrl: d.publicUrl + '/marketplace' };
        handBack(res, r, msg, `<h1 class="ok">Linked</h1><p class="sub" id="note">${r.role === 'BUY'
          ? `The Solutions Farm now buys with <b>${esc(out.agent.name)}</b>, up to $${(Number(out.grant!.maxMinor) / 100).toFixed(2)}.`
          : `Sales are paid into <b>${esc(out.agent.name)}</b>. Register your vendor on the Solutions Farm to finish.`} Returning…</p>`);
      } catch (e) {
        await form(res, owner, r, (e as Error).message);
      }
      return true;
    }

    if (p === '/api/bazaar/links' && method === 'GET') {
      const owner = await d.sessionOwner(req);
      if (!owner) { sendJson(res, 401, { error: 'SIGN_IN_REQUIRED' }); return true; }
      sendJson(res, 200, { storefrontUrl: d.bazaarPublicUrl, links: await d.links.list(owner.id), vendorIds: await d.links.vendorIds(owner.id) });
      return true;
    }
    let m: RegExpMatchArray | null;
    if (method === 'POST' && (m = p.match(/^\/api\/bazaar\/links\/([^/]+)\/revoke$/))) {
      const owner = await d.sessionOwner(req);
      if (!owner) { sendJson(res, 401, { error: 'SIGN_IN_REQUIRED' }); return true; }
      try { sendJson(res, 200, { link: await d.links.revoke(owner.id, decodeURIComponent(m[1])) }); }
      catch (e) { sendJson(res, 404, { error: (e as Error).message }); }
      return true;
    }
    return false;
  };
}
