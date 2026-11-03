import { IncomingMessage, ServerResponse } from 'node:http';
import { AgentConnection, PrismaClient } from '@prisma/client';
import { AgentDevService } from '../agentdev/AgentDevService';
import { AgentWalletService } from '../services/AgentWalletService';
import { GasService } from '../market/GasService';
import { BazaarBridge } from '../bazaar/BazaarBridge';
import { SERVICES } from '../market/catalog';
import { AgentConnectService, MANDATE_SERVICE_IDS, MandateInput } from './AgentConnectService';
import { SUPPORTED_PROTOCOL_VERSIONS, handleMcpMessage } from './mcpServer';
import { ALL_SCOPES, PROVIDERS, SCOPES, isPublicUrl, providerFromClientName, setupFor } from './providers';
import { buildAgentCard, LegalInfo } from './agentCard';
import { RateLimiter, clientIp } from './rateLimit';
import { DataAgentService } from '../data/DataAgentService';
import { PLATFORMS } from '../market/directory';
import { buildPlan, needsFor } from '../market/plan';
import { AgencyService } from '../agency/AgencyService';
import { SkillMarket, invitations } from '../skills/SkillMarket';
import { SelectionKind, allowedServicesFrom, directory, validateSelections } from '../market/directory';

// ---------------------------------------------------------------------------
// HTTP surface for Agent Connect + the Gas marketplace.
//
//   /mcp                                       remote MCP (Streamable HTTP, JSON responses)
//   /.well-known/oauth-protected-resource      RFC 9728   (also /…/mcp)
//   /.well-known/oauth-authorization-server    RFC 8414
//   /oauth/register | authorize | token | revoke   OAuth 2.1 + DCR + PKCE
//   /api/connect/providers                     who can connect and how
//   /api/agents/:id/connections                owner: create/list connections
//   /api/connections/:id/{revoke,rotate,mandate}
//   /api/market/services, /api/agents/:id/gas/{estimate,pay}, /api/agents/:id/orders/:orderId
//   /api/marketplace                           directory: platforms, services, live Bazaar listings
//   /api/agents/:id/market/selections          GET / PUT the agent's marketplace selections
//
// DEV HARNESS: owner endpoints and the consent screen identify the owner by
// email with no password, like the rest of this server. Production must put a
// real owner session (and CSRF protection) in front of them.
// ---------------------------------------------------------------------------

export interface ConnectDeps {
  prisma: PrismaClient;
  connect: AgentConnectService;
  dev: AgentDevService;
  wallet: AgentWalletService;
  gas: GasService;
  bazaar?: BazaarBridge | null;
  data?: DataAgentService | null;
  agency?: AgencyService | null;
  skills?: SkillMarket | null;
  publicUrl: string;
  /** The signed-in PayPali owner (session cookie), for the OAuth consent screen. */
  sessionOwner?: (req: IncomingMessage) => Promise<{ id: string; email: string } | null>;
  /** Dev only: allow the consent screen to sign in with an email and no password. */
  devEmailConsent?: boolean;
  allowedOrigins: string[];
  /** Commercial/legal wrapper: surfaced in the Agent Card, provider directory and OAuth metadata. */
  legal?: LegalInfo | null;
  /** Per-caller request caps (requests/minute). 0 disables a limit. Defaults: mcp 240, oauth 40. */
  rateLimits?: { mcpPerMin?: number; oauthPerMin?: number };
}

const big = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body, big));
}

async function readRaw(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const raw = await readRaw(req, 100_000);
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('application/json')) {
    try { const j = JSON.parse(raw || '{}'); return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])); }
    catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

const toBig = (v: unknown): bigint | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return BigInt(v.trim());
  throw new Error('INVALID_AMOUNT');
};
const dollarsToMinor = (v: string | undefined): bigint | undefined => {
  if (!v || !v.trim()) return undefined;
  const n = Number(v);
  if (!isFinite(n) || n <= 0) throw new Error('INVALID_AMOUNT');
  return BigInt(Math.round(n * 100));
};

export function connectionView(c: AgentConnection) {
  return {
    id: c.id, agentId: c.agentId, provider: c.provider, label: c.label, auth: c.auth, scopes: c.scopes, status: c.status,
    mandate: { currency: c.currency, maxPerTxMinor: c.maxPerTxMinor, maxDailyMinor: c.maxDailyMinor, approvalAboveMinor: c.approvalAboveMinor, allowedServices: c.allowedServices, allowRecurring: c.allowRecurring, expiresAt: c.expiresAt },
    lastUsedAt: c.lastUsedAt, createdAt: c.createdAt, revokedAt: c.revokedAt,
  };
}

function mandateFromBody(m: any): MandateInput {
  return {
    maxPerTxMinor: toBig(m?.maxPerTxMinor) as bigint,
    maxDailyMinor: toBig(m?.maxDailyMinor) as bigint,
    approvalAboveMinor: toBig(m?.approvalAboveMinor) ?? null,
    allowedServices: Array.isArray(m?.allowedServices) ? m.allowedServices : undefined,
    allowRecurring: m?.allowRecurring === undefined ? undefined : m.allowRecurring,
    expiresAt: m?.expiresAt ? new Date(m.expiresAt) : null,
  };
}

const OAUTH_ERRORS = new Set(['invalid_request', 'invalid_client', 'invalid_grant', 'unsupported_grant_type', 'invalid_redirect_uri', 'invalid_client_metadata', 'invalid_target', 'unsupported_response_type']);
const oauthError = (e: unknown) => {
  const m = e instanceof Error ? e.message : 'server_error';
  const [code, desc] = m.split(':');
  return OAUTH_ERRORS.has(code) ? { error: code, ...(desc ? { error_description: desc } : {}) } : { error: 'invalid_request', error_description: m };
};

export function createConnectRoutes(d: ConnectDeps) {
  const MCP_URL = d.publicUrl + '/mcp';
  // The remote MCP endpoint is served at /mcp and also at the /amorti alias (e.g. mcp.supremetechy.com/amorti),
  // so a client configured with either path works end to end, including RFC 9728 OAuth discovery and the
  // resource indicator. /mcp stays the canonical URL shown in the directory and setup snippets.
  const MCP_PATHS = ['/mcp', '/amorti'];
  const mcpUrls = MCP_PATHS.map((x) => d.publicUrl + x);
  // The resource the client is talking about: accept any known MCP path it sends, else fall back to canonical /mcp.
  const resolveResource = (requested?: string | null) => (requested && mcpUrls.includes(requested) ? requested : MCP_URL);
  const PRM_URL = d.publicUrl + '/.well-known/oauth-protected-resource';
  const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-expose-headers': 'www-authenticate, mcp-session-id' };
  const publicOrigin = new URL(d.publicUrl).origin;

  // Per-caller request caps. MCP is keyed by connection id (post-auth); the pre-auth OAuth
  // endpoints are keyed by client IP so one source can't flood registration/token.
  const mcpLimiter = new RateLimiter(d.rateLimits?.mcpPerMin ?? 240);
  const oauthLimiter = new RateLimiter(d.rateLimits?.oauthPerMin ?? 40);
  const tooMany = (res: ServerResponse, dec: { retryAfter: number; limit: number }) =>
    send(res, 429, { error: 'RATE_LIMITED', retryAfterSeconds: dec.retryAfter, limitPerMinute: dec.limit }, { ...CORS, 'retry-after': String(dec.retryAfter) });

  const protectedResource = (resource = MCP_URL) => ({
    resource, authorization_servers: [d.publicUrl], scopes_supported: ALL_SCOPES, bearer_methods_supported: ['header'],
    resource_name: 'PayPali', resource_documentation: d.publicUrl + '/api/connect/providers',
    ...(d.legal ? { tos_uri: d.legal.termsUrl, policy_uri: d.legal.privacyUrl } : {}),
  });
  const authServer = () => ({
    issuer: d.publicUrl,
    authorization_endpoint: d.publicUrl + '/oauth/authorize',
    token_endpoint: d.publicUrl + '/oauth/token',
    registration_endpoint: d.publicUrl + '/oauth/register',
    revocation_endpoint: d.publicUrl + '/oauth/revoke',
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ALL_SCOPES,
    ...(d.legal ? { op_tos_uri: d.legal.termsUrl, op_policy_uri: d.legal.privacyUrl } : {}),
  });

  return async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname, method = req.method ?? 'GET';
    let m: RegExpMatchArray | null;

    if (method === 'OPTIONS' && (MCP_PATHS.includes(p) || p.startsWith('/oauth/') || p.startsWith('/.well-known/'))) {
      res.writeHead(204, CORS); res.end(); return true;
    }

    // ---------------- remote MCP ----------------
    if (MCP_PATHS.includes(p)) {
      if (method !== 'POST') { send(res, 405, { error: 'method_not_allowed' }, { allow: 'POST, OPTIONS', ...CORS }); return true; }
      const origin = req.headers.origin;
      if (origin && origin !== publicOrigin && !d.allowedOrigins.includes(origin)) { send(res, 403, { error: 'origin_not_allowed' }, CORS); return true; }
      const pv = req.headers['mcp-protocol-version'];
      if (pv && !SUPPORTED_PROTOCOL_VERSIONS.includes(String(pv))) { send(res, 400, { error: 'unsupported_protocol_version', supported: SUPPORTED_PROTOCOL_VERSIONS }, CORS); return true; }
      const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''))?.[1];
      let ctx;
      try { ctx = await d.connect.authenticate(bearer); }
      catch (e) {
        const code = (e as Error).message;
        send(res, 401, { error: code }, { ...CORS, 'www-authenticate': `Bearer resource_metadata="${PRM_URL + p}"` + (bearer ? `, error="invalid_token", error_description="${code}"` : '') });
        return true;
      }
      const rl = mcpLimiter.take(ctx.connection.id);
      if (!rl.ok) { tooMany(res, rl); return true; }
      let body: unknown;
      try { body = JSON.parse(await readRaw(req)); }
      catch { send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, CORS); return true; }
      const msgs = Array.isArray(body) ? body : [body];
      const deps = { dev: d.dev, wallet: d.wallet, gas: d.gas, bazaar: d.bazaar, data: d.data, agency: d.agency, skills: d.skills };
      const out = (await Promise.all(msgs.map((x) => handleMcpMessage(ctx!, x as never, deps)))).filter((x) => x !== null);
      if (!out.length) { res.writeHead(202, CORS); res.end(); return true; }
      send(res, 200, Array.isArray(body) ? out : out[0], CORS);
      return true;
    }

    // ---------------- OAuth discovery ----------------
    if (method === 'GET' && (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp')) { send(res, 200, protectedResource(MCP_URL), CORS); return true; }
    if (method === 'GET' && p === '/.well-known/oauth-protected-resource/amorti') { send(res, 200, protectedResource(d.publicUrl + '/amorti'), CORS); return true; }
    if (method === 'GET' && (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/openid-configuration')) { send(res, 200, authServer(), CORS); return true; }

    // ---------------- A2A discovery: Agent Card ----------------
    // Lets any agent framework that looks for an Agent Card find PayPali, learn its
    // tools (as A2A skills), how to authenticate, and its terms. The usable endpoint
    // stays the MCP URL carried inside the card.
    if (method === 'GET' && (p === '/.well-known/agent.json' || p === '/.well-known/agent-card.json')) {
      send(res, 200, buildAgentCard({ publicUrl: d.publicUrl, mcpUrl: MCP_URL, legal: d.legal ?? null }), CORS);
      return true;
    }

    // ---------------- OAuth endpoints ----------------
    // Pre-auth write endpoints are IP-rate-limited so one source can't flood DCR / token exchange.
    if (method === 'POST' && p.startsWith('/oauth/')) {
      const rl = oauthLimiter.take(clientIp(req));
      if (!rl.ok) { tooMany(res, rl); return true; }
    }
    if (method === 'POST' && p === '/oauth/register') {
      try { send(res, 201, await d.connect.registerClient(JSON.parse(await readRaw(req, 50_000) || '{}')), CORS); }
      catch (e) { send(res, 400, oauthError(e), CORS); }
      return true;
    }
    if (p === '/oauth/authorize') {
      const q = Object.fromEntries(url.searchParams) as Record<string, string>;
      if (method === 'GET') {
        let checked;
        try { checked = await d.connect.checkAuthorizeRequest(q, resolveResource(q.resource)); }
        catch (e) { html(res, 400, errorPage((e as Error).message)); return true; }
        const me = d.sessionOwner ? await d.sessionOwner(req) : null;
        const email = me ? me.email : d.devEmailConsent ? (q.login_email || '').trim().toLowerCase() : '';
        const owner = email ? await d.connect.ownerAgentsByEmail(email) : null;
        const here = '/oauth/authorize?' + new URLSearchParams(Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'login_email'))).toString();
        html(res, 200, consentPage({ q, client: checked.client, scopes: checked.scopes, email, owner, signedIn: !!me, devEmail: !!d.devEmailConsent, loginHref: '/login?next=' + encodeURIComponent(here) }));
        return true;
      }
      if (method === 'POST') {
        const f = await readForm(req);
        const params = Object.fromEntries(['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'].map((k) => [k, f[k]])) as Record<string, string>;
        let checked;
        const resource = resolveResource(params.resource);
        try { checked = await d.connect.checkAuthorizeRequest(params, resource); }
        catch (e) { html(res, 400, errorPage((e as Error).message)); return true; }   // never redirect to an unvalidated URI
        const back = new URL(params.redirect_uri);
        if (f.decision !== 'approve') {
          back.searchParams.set('error', 'access_denied');
          if (params.state) back.searchParams.set('state', params.state);
          res.writeHead(302, { location: back.toString() }); res.end(); return true;
        }
        const me = d.sessionOwner ? await d.sessionOwner(req) : null;
        const consentEmail = me ? me.email : d.devEmailConsent ? (f.login_email || '') : '';
        try {
          if (!consentEmail) throw new Error('SIGN_IN_REQUIRED');
          const owner = await d.connect.ownerAgentsByEmail(consentEmail);
          if (!owner) throw new Error('OWNER_NOT_FOUND');
          const services = f.services_all === 'on' ? ['*'] : [...MANDATE_SERVICE_IDS, 'data:*'].filter((id) => f['svc_' + id] === 'on');
          const days = Number(f.expires_days || 0);
          const out = await d.connect.approve(owner.ownerId, params, resource, {
            agentId: f.agent_id, provider: f.provider || providerFromClientName(checked.client.name), label: f.label,
            scopes: ALL_SCOPES.filter((s) => f['scope_' + s] === 'on'),
            mandate: {
              maxPerTxMinor: dollarsToMinor(f.max_per_tx) as bigint, maxDailyMinor: dollarsToMinor(f.max_daily) as bigint,
              approvalAboveMinor: dollarsToMinor(f.approval_above) ?? null, allowedServices: services.length ? services : ['*'],
              allowRecurring: f.allow_recurring === 'on',
              expiresAt: days > 0 ? new Date(Date.now() + days * 86_400_000) : null,
            },
          });
          res.writeHead(302, { location: out.redirect }); res.end();
        } catch (e) {
          html(res, 400, consentPage({ q: params, client: checked.client, scopes: checked.scopes, email: consentEmail, owner: consentEmail ? await d.connect.ownerAgentsByEmail(consentEmail) : null, error: (e as Error).message, signedIn: !!me, devEmail: !!d.devEmailConsent, loginHref: '/login?next=' + encodeURIComponent('/oauth/authorize?' + new URLSearchParams(params).toString()) }));
        }
        return true;
      }
    }
    if (method === 'POST' && p === '/oauth/token') {
      const f = await readForm(req);
      try {
        const out = f.grant_type === 'authorization_code' ? await d.connect.exchangeCode(f)
          : f.grant_type === 'refresh_token' ? await d.connect.refresh(f)
          : (() => { throw new Error('unsupported_grant_type'); })();
        send(res, 200, out, { ...CORS, pragma: 'no-cache' });
      } catch (e) { send(res, 400, oauthError(e), CORS); }
      return true;
    }
    if (method === 'POST' && p === '/oauth/revoke') {
      const f = await readForm(req);
      await d.connect.revokeToken(f.token);
      send(res, 200, {}, CORS);
      return true;
    }

    // ---------------- owner: connections ----------------
    if (method === 'GET' && p === '/api/connect/providers') {
      send(res, 200, {
        mcpUrl: MCP_URL, publicUrl: d.publicUrl, publicUrlReachable: isPublicUrl(d.publicUrl), scopes: SCOPES,
        agentCard: d.publicUrl + '/.well-known/agent.json', legal: d.legal ?? null,
        providers: PROVIDERS.map((pr) => ({ id: pr.id, name: pr.name, vendor: pr.vendor, surfaces: setupFor(pr.id, MCP_URL) })),
        platforms: PLATFORMS.map((pl) => ({ id: pl.id, name: pl.name, vendor: pl.vendor, providerId: pl.providerId, connect: pl.connect })),
      });
      return true;
    }
    if ((m = p.match(/^\/api\/agents\/([^/]+)\/connections$/))) {
      const agentId = decodeURIComponent(m[1]);
      if (method === 'GET') { send(res, 200, { connections: (await d.connect.list({ agentId })).map(connectionView) }); return true; }
      if (method === 'POST') {
        const b = JSON.parse((await readRaw(req)) || '{}');
        const ownerId = await ownerOfAgent(d, agentId);
        const { connection, token } = await d.connect.createConnection(ownerId, agentId, { provider: b.provider, label: b.label, scopes: b.scopes, mandate: mandateFromBody(b.mandate) });
        send(res, 200, { connection: connectionView(connection), token, tokenNote: 'Shown once. PayPali stores only its hash.', mcpUrl: MCP_URL, setup: setupFor(connection.provider, MCP_URL, token ?? undefined) });
        return true;
      }
    }
    if ((m = p.match(/^\/api\/connections\/([^/]+)\/(revoke|rotate|mandate)$/)) && (method === 'POST' || method === 'PATCH')) {
      const id = decodeURIComponent(m[1]);
      const c = await d.prisma.agentConnection.findUnique({ where: { id } });
      if (!c) { send(res, 404, { error: 'CONNECTION_NOT_FOUND' }); return true; }
      if (m[2] === 'revoke') { send(res, 200, connectionView(await d.connect.revoke(c.ownerId, id))); return true; }
      if (m[2] === 'rotate') { const r = await d.connect.rotateToken(c.ownerId, id); send(res, 200, { ...r, setup: setupFor(c.provider, MCP_URL, r.token) }); return true; }
      const b = JSON.parse((await readRaw(req)) || '{}');
      const patch: Partial<MandateInput> = {};
      if (b.maxPerTxMinor !== undefined) patch.maxPerTxMinor = toBig(b.maxPerTxMinor);
      if (b.maxDailyMinor !== undefined) patch.maxDailyMinor = toBig(b.maxDailyMinor);
      if (b.approvalAboveMinor !== undefined) patch.approvalAboveMinor = toBig(b.approvalAboveMinor) ?? null;
      if (b.allowedServices !== undefined) patch.allowedServices = b.allowedServices;
      if (b.allowRecurring !== undefined) patch.allowRecurring = b.allowRecurring;
      if (b.expiresAt !== undefined) patch.expiresAt = b.expiresAt ? new Date(b.expiresAt) : null;
      send(res, 200, connectionView(await d.connect.updateMandate(c.ownerId, id, patch)));
      return true;
    }

    // ---------------- Owner inbox: Bazaar purchases awaiting confirmation ----------------
    if (p === '/api/bazaar/approvals' || (m = p.match(/^\/api\/bazaar\/approvals\/([^/]+)\/(approve|reject)$/))) {
      if (method !== 'GET' && method !== 'POST') {
        send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      const owner = d.sessionOwner ? await d.sessionOwner(req) : null;
      if (!owner) {
        send(res, 401, { error: 'SIGN_IN_REQUIRED' });
        return true;
      }
      if (!d.bazaar) {
        send(res, 503, { error: 'BAZAAR_NOT_CONFIGURED' });
        return true;
      }
      if (p === '/api/bazaar/approvals') {
        if (method !== 'GET') {
          send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
          return true;
        }
        send(res, 200, await d.bazaar.heldPurchases(owner.id));
        return true;
      }

      if (method !== 'POST' || !m) {
        send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      const body = await readForm(req);
      const orderId = decodeURIComponent(m[1]);
      try {
        if (m[2] === 'approve') {
          const confidencePct = body.confidencePct === undefined
            ? undefined
            : Number(body.confidencePct);
          if (confidencePct !== undefined && (!Number.isInteger(confidencePct) || confidencePct < 1 || confidencePct > 99)) {
            send(res, 400, { error: 'INVALID_CONFIDENCE' });
            return true;
          }
          send(res, 200, await d.bazaar.approve(owner.id, orderId, { confidencePct }));
          return true;
        }
        send(res, 200, { rejected: true, order: await d.bazaar.reject(owner.id, orderId, body.reason) });
        return true;
      } catch (error) {
        const code = error instanceof Error ? error.message : 'APPROVAL_ACTION_FAILED';
        const status = code === 'AGENT_NOT_OWNED' ? 403
          : code === 'ORDER_NOT_FOUND' ? 404
          : code === 'NOT_AWAITING_APPROVAL' ? 409
          : 400;
        send(res, status, { error: code });
        return true;
      }
    }

    // ---------------- AgentBazaar for in-platform agents + their owners ----------------
    if (p === '/api/bazaar/search' || p.startsWith('/api/agents/') && p.includes('/bazaar')) {
      if (!d.bazaar) { send(res, 503, { error: 'BAZAAR_NOT_CONFIGURED', hint: 'Set AGENTBAZAAR_URL (or run npm run stack)' }); return true; }
      const bz = d.bazaar;
      if (method === 'GET' && p === '/api/bazaar/search') {
        send(res, 200, await bz.search({ query: url.searchParams.get('q') ?? undefined, category: url.searchParams.get('category') ?? undefined, minTier: Number(url.searchParams.get('min_tier')) || undefined }));
        return true;
      }
      if ((m = p.match(/^\/api\/agents\/([^/]+)\/bazaar(?:\/(enable|disable|buy|run|report|pending|approvals|attest|refund|identity|policy)|\/orders\/([^/]+)\/(resume|approve|reject))?$/))) {
        const agentId = decodeURIComponent(m[1]);
        const op = m[2] ?? (m[3] ? m[4]! : 'status');
        const b = method === 'POST' ? JSON.parse((await readRaw(req)) || '{}') : {};
        const owner = () => ownerOfAgent(d, agentId);
        let out: unknown;
        if (op === 'status' && method === 'GET') out = await bz.status(agentId);
        else if (op === 'pending' && method === 'GET') out = await bz.pending(await owner());           // OWNER
        else if (op === 'approvals' && method === 'GET') out = await bz.heldPurchases(await owner());   // OWNER: CONFIRM holds awaiting a decision
        else if (op === 'policy' && method === 'GET') out = await bz.policy.getPolicies(agentId);       // effective per-category policy
        else if (method !== 'POST') { send(res, 405, { error: 'method_not_allowed' }); return true; }
        else if (op === 'approve') out = await bz.approve(await owner(), decodeURIComponent(m[3]!), { confidencePct: b.confidencePct, intentKey: b.intentKey });   // OWNER: confirm a held purchase
        else if (op === 'reject') out = { rejected: true, order: await bz.reject(await owner(), decodeURIComponent(m[3]!), b.reason) };                             // OWNER: decline a held purchase (not a payment failure)
        else if (op === 'enable') out = await bz.enable(await owner(), agentId, { budgetMinor: toBig(b.budgetMinor), capMinor: toBig(b.capMinor), minTier: b.minTier, days: b.days });
        else if (op === 'disable') out = await bz.disable(await owner(), agentId);
        else if (op === 'attest') out = await bz.attest(await owner(), b.runId, b.verdict, b.note, b.observed);   // OWNER
        else if (op === 'identity') out = (await bz.attachIdentity(await owner())) ?? { error: 'IDENTITY_ISSUER_NOT_CONFIGURED' };   // OWNER
        else if (op === 'policy') out = b.clear === true                                                 // OWNER: set or clear a category override
          ? await bz.policy.clearPolicy(await owner(), agentId, b.category)
          : await bz.policy.setPolicy(await owner(), agentId, b.category, { permission: b.permission, maxAmountMinor: toBig(b.maxAmountMinor) });
        else if (op === 'refund') out = await bz.refund(agentId, b.receiptId);
        else if (op === 'buy') out = await bz.buy(agentId, { solutionId: b.solutionId, confidencePct: b.confidencePct, intentKey: b.intentKey, category: b.category, trigger: b.trigger, beneficiary: b.beneficiary, budgetOwner: b.budgetOwner, onFailure: b.onFailure, recurring: b.recurring === true, paidAccess: b.paidAccess === true, personalData: b.personalData === true });
        else if (op === 'resume') out = await bz.resume(agentId, decodeURIComponent(m[3]!), { confidencePct: b.confidencePct, intentKey: b.intentKey });
        else if (op === 'run') out = await bz.run(agentId, b.receiptId, b.input ?? {});
        else if (op === 'report') out = await bz.report(agentId, b.runId, b.success, b.observed);
        const st = (out as { status?: string })?.status;
        send(res, st === 'DECLINED' || st === 'FAILED' ? 402 : 200, out);
        return true;
      }
    }

    // ---------------- Marketplace directory + per-agent selections (the /marketplace page) ----------------
    if (method === 'GET' && p === '/api/marketplace') {
      let listings: any[] = [], bazaarError: string | null = null;
      if (d.bazaar) { try { listings = (await d.bazaar.search({})).results; } catch (e) { bazaarError = (e as Error).message; } }
      // Every seller is an agent: name the PayPali agent behind each listing where the Bazaar knows it.
      const sellerIds = [...new Set(listings.map((l: any) => l.sellerAgentId).filter(Boolean))] as string[];
      const sellerNames = sellerIds.length ? await d.prisma.agent.findMany({ where: { id: { in: sellerIds } }, select: { id: true, name: true } }) : [];
      listings = listings.map((l: any) => ({ ...l, sellerAgent: l.sellerAgentId ? { id: l.sellerAgentId, name: sellerNames.find((x) => x.id === l.sellerAgentId)?.name ?? null } : null }));
      const skills = d.skills ? await d.skills.list() : [];
      const agentsSelling = new Map<string, { id: string; name: string; active: boolean; skills: string[]; access: boolean }>();
      for (const sk of skills) if (sk.seller) {
        const a = agentsSelling.get(sk.seller.agentId) ?? { id: sk.seller.agentId, name: sk.seller.name, active: sk.seller.active, skills: [], access: false };
        a.skills.push(sk.slug); a.access ||= sk.kind === 'ACCESS'; agentsSelling.set(a.id, a);
      }
      const featured = listings.slice().sort((a, b) => (b.tier - a.tier) || (b.claimedSuccess - a.claimedSuccess)).slice(0, 4);
      const dir = directory(d.gas.listServices({}));
      send(res, 200, {
        mcpUrl: MCP_URL, scopes: SCOPES, gas: d.gas.cfg, ...dir,
        bazaar: { connected: !!d.bazaar && !bazaarError, error: d.bazaar ? bazaarError : 'BAZAAR_NOT_CONFIGURED' },
        featured, listings, skills, agents: [...agentsSelling.values()],
        // Brands with no partnership yet are shown as invitations to open a provider agent account, never as providers.
        invitations: invitations((process.env.PAYPALI_PARTNER_PROVIDERS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)),
        dataAgents: d.data ? await d.data.list() : [],
      });
      return true;
    }
    // What's left before the agent can use each selected item, and how it uses it.
    if (method === 'GET' && (m = p.match(/^\/api\/agents\/([^/]+)\/market\/plan$/))) {
      const live = new Map(d.gas.listServices({}).map((sv: any) => [sv.id, sv.portal?.status]));
      send(res, 200, await buildPlan({ prisma: d.prisma, dev: d.dev, wallet: d.wallet, bazaar: d.bazaar, agency: d.agency, portalStatus: (id) => live.get(id) }, decodeURIComponent(m[1])));
      return true;
    }
    // Owner act: widen the agent's connections so its assistant can use the selections (scopes + allowed services).
    if (method === 'POST' && (m = p.match(/^\/api\/agents\/([^/]+)\/market\/extend-access$/))) {
      const agentId = decodeURIComponent(m[1]);
      const ownerId = await ownerOfAgent(d, agentId);
      const b = JSON.parse((await readRaw(req)) || '{}');
      const rows = await d.prisma.marketSelection.findMany({ where: { agentId } });
      const need = needsFor(rows.map((r) => ({ kind: r.kind as SelectionKind, id: r.itemId })));
      const conns = await d.prisma.agentConnection.findMany({ where: { agentId, status: 'ACTIVE', ...(Array.isArray(b.connectionIds) ? { id: { in: b.connectionIds } } : {}) } });
      const results = [];
      for (const c of conns) {
        const r = await d.connect.extendAccess(ownerId, c.id, { scopes: need.scopes, services: need.services });
        results.push({ connectionId: c.id, label: c.label, addedScopes: r.addedScopes, addedServices: r.addedServices });
      }
      send(res, 200, { updated: results });
      return true;
    }
    if ((m = p.match(/^\/api\/agents\/([^/]+)\/market\/selections$/))) {
      const agentId = decodeURIComponent(m[1]);
      await ownerOfAgent(d, agentId);   // 404s unknown agents
      if (method === 'PUT') {
        const b = JSON.parse((await readRaw(req)) || '{}');
        const items = validateSelections(b.items);
        const bz = items.filter((i) => i.kind === 'bazaar');
        const dz = items.filter((i) => i.kind === 'data');
        if (dz.length) {
          const known = new Set((await d.prisma.dataAgent.findMany({ where: { slug: { in: dz.map((i) => i.id) } }, select: { slug: true } })).map((x) => x.slug));
          const missing = dz.find((i) => !known.has(i.id));
          if (missing) throw new Error(`UNKNOWN_DATA_AGENT:${missing.id}`);
        }
        if (bz.length && d.bazaar) {
          const known = new Set((await d.bazaar.search({})).results.map((r: any) => r.id));
          const missing = bz.find((i) => !known.has(i.id));
          if (missing) throw new Error(`UNKNOWN_BAZAAR_LISTING:${missing.id}`);
        }
        await d.prisma.$transaction([
          d.prisma.marketSelection.deleteMany({ where: { agentId } }),
          d.prisma.marketSelection.createMany({ data: items.map((i) => ({ agentId, kind: i.kind, itemId: i.id })) }),
        ]);
      } else if (method !== 'GET') { send(res, 405, { error: 'method_not_allowed' }); return true; }
      const rows = await d.prisma.marketSelection.findMany({ where: { agentId }, orderBy: { createdAt: 'asc' } });
      const items = rows.map((r) => ({ kind: r.kind as SelectionKind, id: r.itemId }));
      send(res, 200, { agentId, items, allowedServices: allowedServicesFrom(items) });
      return true;
    }

    // ---------------- marketplace (in-platform agents, no connection) ----------------
    if (method === 'GET' && p === '/api/market/services') {
      send(res, 200, { gas: d.gas.cfg, services: d.gas.listServices({ query: url.searchParams.get('q') ?? undefined, category: url.searchParams.get('category') ?? undefined }) });
      return true;
    }
    if (method === 'POST' && (m = p.match(/^\/api\/agents\/([^/]+)\/gas\/(estimate|pay)$/))) {
      const agentId = decodeURIComponent(m[1]);
      const b = JSON.parse((await readRaw(req)) || '{}');
      if (m[2] === 'estimate') send(res, 200, await d.gas.estimate(agentId, { serviceId: b.serviceId, actionId: b.actionId, params: b.params ?? {} }));
      else { const r = await d.gas.pay(agentId, { quoteId: b.quoteId, confidencePct: b.confidencePct, intentKey: b.intentKey }); send(res, ['DECLINED', 'UNSUPPORTED', 'FAILED'].includes(r.status) ? 402 : 200, r); }
      return true;
    }
    if (method === 'GET' && (m = p.match(/^\/api\/agents\/([^/]+)\/orders\/([^/]+)$/))) {
      send(res, 200, await d.gas.getOrder(decodeURIComponent(m[1]), decodeURIComponent(m[2])));
      return true;
    }
    return false;
  };
}

async function ownerOfAgent(d: ConnectDeps, agentId: string): Promise<string> {
  const a = await d.prisma.agent.findUnique({ where: { id: agentId } });
  if (!a) throw new Error('AGENT_NOT_FOUND');
  return a.ownerId;
}

// ---------------------------------------------------------------------------
// Consent screen (server-rendered, no scripts)
// ---------------------------------------------------------------------------
function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(body);
}

const PAGE_CSS = `:root{--bg:#f4f6f3;--card:#fff;--ink:#14201b;--mute:#5d6b64;--line:#d9e0da;--acc:#1f7a5c;--bad:#b3392b}
@media(prefers-color-scheme:dark){:root{--bg:#0e1512;--card:#152019;--ink:#e6efe9;--mute:#93a59b;--line:#27352d;--acc:#4fc79c;--bad:#ef7d6d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:560px;margin:0 auto;padding:28px 16px 48px}h1{font-size:1.45rem;margin:0 0 4px}.sub{color:var(--mute);margin:0 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
label{display:block;font-weight:600;font-size:.86rem;margin:10px 0 4px}input,select{width:100%;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}.chk{display:flex;gap:8px;align-items:flex-start;font-weight:400;margin:6px 0}.chk input{width:auto;margin-top:4px}
.hint{color:var(--mute);font-size:.8rem;margin:4px 0 0}.err{color:var(--bad);font-weight:600}
.actions{display:flex;gap:10px;margin-top:6px}button{font:inherit;font-weight:600;border-radius:8px;padding:10px 16px;border:1px solid var(--ink);background:var(--ink);color:var(--bg);cursor:pointer}
button.ghost{background:transparent;color:var(--ink);border-color:var(--line)}.pill{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:1px 9px;font-size:.78rem;color:var(--mute)}
.dev{border-left:3px solid var(--bad);padding-left:10px;color:var(--mute);font-size:.8rem}
a.btn{display:inline-block;font-weight:600;border-radius:8px;padding:10px 16px;background:var(--ink);color:var(--bg);text-decoration:none}`;

function errorPage(msg: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PayPali sign-in</title><style>${PAGE_CSS}</style></head>
<body><main><h1>This sign-in link is not valid</h1><p class="sub">The app that sent you here made a request PayPali cannot accept, so nothing was connected.</p><div class="card"><span class="err">${esc(msg)}</span></div></main></body></html>`;
}

function consentPage(o: { q: Record<string, string>; client: { name: string }; scopes: string[]; email?: string; owner: { ownerId: string; agents: { id: string; name: string }[] } | null; error?: string; signedIn?: boolean; devEmail?: boolean; loginHref?: string }) {
  const hidden = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']
    .filter((k) => o.q[k] !== undefined).map((k) => `<input type="hidden" name="${k}" value="${esc(o.q[k])}">`).join('');
  const guess = providerFromClientName(o.client.name);
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(o.q).filter(([k]) => k !== 'login_email')));
  const signInStep = `<div class="card"><p>Sign in to PayPali to choose which of your agents ${esc(o.client.name)} acts as. You’ll come straight back here.</p>
    <div class="actions"><a class="btn" href="${esc(o.loginHref ?? '/login')}">Sign in to PayPali</a></div>
    ${o.signedIn && !o.owner?.agents.length ? '<p class="hint err">Your account has no active agents yet. <a href="/">Create one</a>, then try again.</p>' : ''}</div>`;
  const emailStep = (!o.devEmail || o.signedIn) ? signInStep : `<form method="get" action="/oauth/authorize" class="card">${[...qs].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}
    <label for="e">Your PayPali email</label><input id="e" name="login_email" type="email" required value="${esc(o.email)}" autocomplete="email">
    ${o.email && !o.owner ? '<p class="hint err">No PayPali account with active agents uses this email.</p>' : ''}
    <div class="actions"><button>Continue</button></div><p class="dev">Development sign-in: email only, no password. Production needs real owner authentication.</p></form>`;
  if (!o.owner || !o.owner.agents.length) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to PayPali</title><style>${PAGE_CSS}</style></head>
<body><main><h1>Connect ${esc(o.client.name)} to PayPali</h1><p class="sub">Sign in to choose which of your agents it acts as.</p>${o.error ? `<div class="card err">Not connected: ${esc(o.error === 'SIGN_IN_REQUIRED' ? 'sign in to PayPali first (SIGN_IN_REQUIRED)' : o.error)}</div>` : ''}${emailStep}</main></body></html>`;
  }
  const scopeBoxes = ALL_SCOPES.map((s) => `<label class="chk"><input type="checkbox" name="scope_${s}"${o.scopes.includes(s) ? ' checked' : ''}><span>${esc(SCOPES[s])} <span class="pill">${s}</span></span></label>`).join('');
  const svc = [{ id: 'agentbazaar', name: 'AgentBazaar marketplace' }, { id: 'data:*', name: 'All company data agents' }, ...SERVICES].map((s) => `<label class="chk"><input type="checkbox" name="svc_${s.id}"><span>${esc(s.name)}</span></label>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to PayPali</title><style>${PAGE_CSS}</style></head>
<body><main>
<h1>Let ${esc(o.client.name)} act as your agent</h1>
<p class="sub">It will use the agent you pick, inside the limits you set here. Every payment still passes that agent’s Score gate, and you can revoke this connection at any time.</p>
${o.error ? `<div class="card err">Not connected: ${esc(o.error)}</div>` : ''}
<form method="post" action="/oauth/authorize">${hidden}${o.signedIn ? '' : `<input type="hidden" name="login_email" value="${esc(o.email)}">`}
<div class="card">
  <label for="agent">Agent</label><select id="agent" name="agent_id">${o.owner.agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select>
  <div class="row"><div><label for="prov">Assistant</label><select id="prov" name="provider">${PROVIDERS.map((p) => `<option value="${p.id}"${p.id === guess ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
  <div><label for="label">Name this connection</label><input id="label" name="label" value="${esc(o.client.name)}" maxlength="80"></div></div>
</div>
<div class="card"><strong>Permissions</strong>${scopeBoxes}</div>
<div class="card"><strong>Mandate</strong>
  <div class="row"><div><label for="ptx">Max per payment ($)</label><input id="ptx" name="max_per_tx" type="number" min="0.01" step="0.01" value="25" required></div>
  <div><label for="day">Max per 24 hours ($)</label><input id="day" name="max_daily" type="number" min="0.01" step="0.01" value="100" required></div></div>
  <div class="row"><div><label for="appr">Ask me above ($)</label><input id="appr" name="approval_above" type="number" min="0.01" step="0.01" placeholder="optional"></div>
  <div><label for="exp">Expires after (days)</label><input id="exp" name="expires_days" type="number" min="0" step="1" value="30"><p class="hint">0 = no expiry</p></div></div>
  <label>Services</label><label class="chk"><input type="checkbox" name="services_all" checked><span>All marketplace services</span></label>
  <p class="hint">Or untick “All” and choose:</p>${svc}
  <label class="chk"><input type="checkbox" name="allow_recurring"><span>Allow recurring charges (monthly plans and data subscriptions). Off unless you tick it.</span></label>
</div>
<div class="actions"><button name="decision" value="approve">Approve</button><button class="ghost" name="decision" value="deny">Deny</button></div>
${o.signedIn ? `<p class="hint">Signed in to PayPali as ${esc(o.email)}.</p>` : `<p class="dev">Development sign-in as ${esc(o.email)} (no password). <a href="${esc(o.loginHref ?? '/login')}">Sign in properly</a>; servers with PAYPALI_REQUIRE_SESSION=1 always require it.</p>`}
</form></main></body></html>`;
}
