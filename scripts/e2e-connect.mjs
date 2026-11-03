// Live e2e: official MCP TypeScript SDK client <-> PayPali dev server (Streamable HTTP), bearer + OAuth 2.1.
// Run from the PayPali root:  npm i --no-save @modelcontextprotocol/sdk@1 && node scripts/e2e-connect.mjs
import { spawn } from 'node:child_process';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

let fails = 0;
const check = (label, ok, extra) => { if (!ok) fails++; console.log((ok ? '  pass  ' : '  FAIL  ') + label + (extra !== undefined ? `  [${extra}]` : '')); };
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = await freePort(), BASE = `http://localhost:${port}`, MCP = new URL(BASE + '/mcp');
const srv = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, PORT: String(port), PAYPALI_SERVICE_SANDBOX: '1', PAYPALI_PUBLIC_URL: BASE }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
const stop = c => { srv.kill(); process.exit(c); };
for (let i = 0; i < 200; i++) { try { if ((await fetch(BASE + '/api/agents')).ok) break; } catch {} await sleep(150); }
const J = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }; };
const parse = r => r.structuredContent ?? JSON.parse(r.content[0].text);

const EMAIL = 'supreme@ethertechnology.tech';
const g = await J('POST', '/api/generate', { owner: { email: EMAIL }, objective: { type: 'GROWTH' }, seed: { amountMinor: 50000, currency: 'USD', fundingSourceReference: 'vault_dev' } });
const agentId = g.body.agentId;
for (let i = 0; i < 60; i++) { const a = await J('GET', '/api/agents/' + agentId); if (a.body.accounts?.[0]?.availableMinor > 0) break; await sleep(150); }

console.log('\n1. Discovery: unauthenticated /mcp points clients at OAuth');
const un = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
check('401 with WWW-Authenticate resource_metadata', un.status === 401 && /resource_metadata="[^"]+oauth-protected-resource"/.test(un.headers.get('www-authenticate')), un.headers.get('www-authenticate'));
const prm = await J('GET', '/.well-known/oauth-protected-resource');
const asm = await J('GET', '/.well-known/oauth-authorization-server');
check('protected-resource + authorization-server metadata', prm.body.resource === MCP.href && asm.body.code_challenge_methods_supported[0] === 'S256' && !!asm.body.registration_endpoint);
const providers = await J('GET', '/api/connect/providers');
check('provider registry lists Claude, ChatGPT, Gemini, Grok, Muse', ['claude', 'chatgpt', 'gemini', 'grok', 'muse'].every(id => providers.body.providers.some(p => p.id === id)));

console.log('\n2. Bearer connection (Gemini CLI-style) via the official MCP SDK client');
const conn = await J('POST', `/api/agents/${agentId}/connections`, { provider: 'gemini', scopes: ['context:read', 'wallet:read', 'market:read', 'gas:quote', 'gas:pay'], mandate: { maxPerTxMinor: 5000, maxDailyMinor: 20000, allowedServices: ['uber', 'spotify', 'netflix'] } });
check('owner creates a connection; token shown once with setup snippet', conn.status === 200 && conn.body.token.startsWith('ppk_') && conn.body.setup[0].setup.includes(conn.body.token), conn.body.setup?.[0]?.name);
const c1 = new Client({ name: 'gemini-cli-e2e', version: '1.0.0' });
await c1.connect(new StreamableHTTPClientTransport(MCP, { requestInit: { headers: { Authorization: `Bearer ${conn.body.token}` } } }));
check('SDK initialize handshake', c1.getServerVersion()?.name === 'paypali', JSON.stringify(c1.getServerVersion()));
check('server instructions explain Gas + Score', /Gas/.test(c1.getInstructions() ?? '') && /Score/.test(c1.getInstructions() ?? ''));
const tools = (await c1.listTools()).tools.map(t => t.name);
check('tools/list returns the 7 PayPali tools', tools.length === 7 && tools.includes('pay_with_gas'), tools.join(','));
const ctx = parse(await c1.callTool({ name: 'get_agent_context', arguments: {} }));
check('get_agent_context: Score + mandate + market.service capability', ctx.context.score.balance === 1000 && ctx.context.capabilities.some(c => c.capability === 'market.service'), `score=${ctx.context.score.balance}`);
const est = parse(await c1.callTool({ name: 'estimate_gas', arguments: { service_id: 'uber', action_id: 'request_ride', params: { fare_minor: 1850, pickup: 'Home', dropoff: 'Studio' }, confidence_pct: 85 } }));
check('estimate_gas: Gas quote with Score preview', est.payable && est.gas.total === 18778 && est.score.allowed, `${est.gas.total} gas = ${est.amountMinor}¢, onSuccess=${est.score.onSuccess} onFailure=${est.score.onFailure}`);
const paid = await c1.callTool({ name: 'pay_with_gas', arguments: { quote_id: est.quoteId, confidence_pct: 85, intent_key: 'studio-ride' } });
const po = parse(paid);
check('pay_with_gas: FULFILLED (sandbox), stake WON', !paid.isError && po.status === 'FULFILLED' && po.sandbox && po.settlement.status === 'WON', `${po.status} delta=${po.settlement?.delta}`);
const nf = parse(await c1.callTool({ name: 'estimate_gas', arguments: { service_id: 'hulu', action_id: 'subscribe_ads' } }));
check('mandate blocks a service the owner did not allow', nf.payable === false && nf.blockers.includes('MANDATE_SERVICE_NOT_ALLOWED'));
await c1.close();

console.log('\n3. OAuth 2.1 connection (Claude custom connector-style) via the SDK’s OAuth client');
const store = {};
const provider = {
  get redirectUrl() { return 'https://claude.ai/api/mcp/auth_callback'; },
  get clientMetadata() { return { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; },
  clientInformation: () => store.client, saveClientInformation: c => { store.client = c; },
  tokens: () => store.tokens, saveTokens: t => { store.tokens = t; },
  saveCodeVerifier: v => { store.verifier = v; }, codeVerifier: () => store.verifier,
  // Stand-in for the human: open PayPali's consent screen, sign in, approve.
  redirectToAuthorization: async (authUrl) => {
    store.authUrl = authUrl.href;
    const u = new URL(authUrl); u.searchParams.set('login_email', EMAIL);
    const page = await (await fetch(u)).text();
    store.consentHasAgent = page.includes(agentId) && /Let Claude act as your agent/.test(page);
    const form = new URLSearchParams();
    for (const [, k, v] of page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) form.set(k, v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    form.set('agent_id', agentId); form.set('provider', 'claude'); form.set('label', 'Claude (Cowork)');
    for (const s of ['context:read', 'wallet:read', 'market:read', 'gas:quote']) form.set('scope_' + s, 'on');
    form.set('max_per_tx', '20'); form.set('max_daily', '50'); form.set('services_all', 'on'); form.set('expires_days', '30'); form.set('decision', 'approve');
    const r = await fetch(BASE + '/oauth/authorize', { method: 'POST', body: form, redirect: 'manual' });
    store.redirect = r.headers.get('location');
  },
};
const t1 = new StreamableHTTPClientTransport(MCP, { authProvider: provider });
const c2 = new Client({ name: 'claude-e2e', version: '1.0.0' });
let unauthorized = false;
try { await c2.connect(t1); } catch (e) { unauthorized = e instanceof UnauthorizedError; }
check('SDK discovered PayPali OAuth and registered a client (DCR)', unauthorized && store.client?.client_id?.startsWith('ppc_'), store.client?.client_id);
check('authorize URL carries PKCE S256 + resource', /code_challenge_method=S256/.test(store.authUrl) && /resource=/.test(store.authUrl));
check('consent screen shows the owner’s agent', store.consentHasAgent);
const back = new URL(store.redirect);
check('approval redirects back to the client with a code', back.origin === 'https://claude.ai' && !!back.searchParams.get('code'));
await t1.finishAuth(back.searchParams.get('code'));
check('SDK exchanged the code (PKCE) for tokens', store.tokens?.access_token?.startsWith('ppat_') && store.tokens?.refresh_token?.startsWith('pprt_'));
const c3 = new Client({ name: 'claude-e2e', version: '1.0.0' });
await c3.connect(new StreamableHTTPClientTransport(MCP, { authProvider: provider }));
const t3 = (await c3.listTools()).tools.map(t => t.name);
check('OAuth connection sees only approved scopes (no pay_with_gas)', !t3.includes('pay_with_gas') && t3.includes('estimate_gas'), t3.join(','));
const bal = parse(await c3.callTool({ name: 'get_balance', arguments: {} }));
check('get_balance over OAuth', Number(bal.availableMinor) > 0, bal.availableMinor + '¢');
const list = (await J('GET', `/api/agents/${agentId}/connections`)).body.connections;
const oc = list.find(c => c.auth === 'OAUTH');
check('owner sees both connections (TOKEN gemini, OAUTH claude)', list.length === 2 && oc?.provider === 'claude' && oc.mandate.maxPerTxMinor === '2000');
await c3.close();

console.log('\n4. Revocation');
await J('POST', `/api/connections/${oc.id}/revoke`, {});
const after = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + store.tokens.access_token }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }) });
check('revoked OAuth connection is refused immediately', after.status === 401);
const rf = await fetch(BASE + '/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: store.tokens.refresh_token, client_id: store.client.client_id }) });
check('and its refresh token is dead', rf.status === 400);
const evil = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', authorization: 'Bearer ' + conn.body.token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
check('browser requests from unknown origins are refused (DNS-rebinding guard)', evil.status === 403);

console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll live MCP checks passed');
if (fails) console.log(log.slice(-2000));
stop(fails ? 1 : 0);
