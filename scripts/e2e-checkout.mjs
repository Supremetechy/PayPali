// Live checkout e2e across the real stack: PayPali + AgentBazaar (scripts/dev-stack.mjs), every kind of buyer.
// From the PayPali root:  npm i --no-save @modelcontextprotocol/sdk@1 && node scripts/e2e-checkout.mjs
//   A. PayPali-built agent over HTTP     enable → buy → run → report → owner confirms → stake WON
//   B. External assistant over MCP       bazaar_buy → run → report → owner disputes → stake LOST (bond forfeited)
//   C. Browser-style Bazaar agent        own Ed25519 keys + a PayPali grant → purchase → owner confirms → WON
//   D. Measured attestation              metric listing: owner records the value THEY observed; mismatch flagged
//   E. Owner kill switch                 disable → the connected assistant can no longer buy
//   F. KYC with PayPal                   dev → kyc credential, one PayPal account = one owner, revocation reaches the Bazaar
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { Identity, call: bzCall, makeMandate, verifyDoc } = require(resolve(ROOT, 'AgentBazaar/client.js'));

let fails = 0;
const check = (label, ok, extra) => { if (!ok) fails++; console.log((ok ? '  pass  ' : '  FAIL  ') + label + (extra !== undefined ? `  [${extra}]` : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const [ppPort, bzPort] = [await freePort(), await freePort()];
const PP = `http://localhost:${ppPort}`, BZ = `http://localhost:${bzPort}`;

const ADMIN = 'e2e-admin-' + Math.random().toString(36).slice(2);
const stack = spawn(process.execPath, ['scripts/dev-stack.mjs', '--no-seed'], { cwd: ROOT, env: { ...process.env, PAYPALI_PORT: String(ppPort), BAZAAR_PORT: String(bzPort), STACK_ADMIN_TOKEN: ADMIN }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; stack.stdout.on('data', (d) => (log += d)); stack.stderr.on('data', (d) => (log += d));
const stop = (c) => { stack.kill('SIGTERM'); process.exit(c); };
for (let i = 0; i < 400 && !log.includes('Ctrl+C stops'); i++) await sleep(150);
if (!log.includes('Ctrl+C stops')) { console.error(log); stop(1); }

const J = async (m, p, b) => { const r = await fetch(PP + p, { method: m, headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const until = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return null; await sleep(150); } };
const balance = async (id) => BigInt((await J('GET', '/api/agents/' + id)).body.accounts.find((a) => a.currency === 'USD')?.availableMinor ?? 0);
const reserved = async (id) => BigInt((await J('GET', '/api/agents/' + id)).body.accounts.find((a) => a.currency === 'USD')?.reservedMinor ?? 0);
const score = async (id) => (await J('GET', `/api/agentdev/agents/${id}/context`)).body.score;
async function funded(email, seedMinor) {
  const g = await J('POST', '/api/generate', { owner: { email }, objective: { type: 'GROWTH' }, seed: { amountMinor: seedMinor, currency: 'USD', fundingSourceReference: 'vault_dev' } });
  await until(async () => (await balance(g.body.agentId)) > 0n);
  // The stack requires a signed Power of Agency before an agent can move money (PAYPALI_REQUIRE_POWER_OF_AGENCY=1).
  const d = (await J('GET', `/api/agents/${g.body.agentId}/power-of-agency`)).body;
  await J('POST', `/api/agents/${g.body.agentId}/power-of-agency/sign`, { acceptedTermsSha256: d.draftTermsSha256 });
  return g.body.agentId;
}

console.log('\nA. PayPali-built agent checks out over HTTP');
const a = await funded('owner-a@example.com', 50_000);
const en = await J('POST', `/api/agents/${a}/bazaar/enable`, { budgetMinor: 20_000, capMinor: 6_000 });
check('owner enables AgentBazaar (grant + signed, PayPali-funded mandate)', en.status === 200 && en.body.enabled, en.body?.mandateId ?? JSON.stringify(en.body));
check('PayPali vouches for the owner: identity credential accepted, attestations count', en.body.identity?.countsAsEvidence === true && en.body.identity.issuer === 'paypali', JSON.stringify(en.body.identity));
const found = await J('GET', '/api/bazaar/search?q=fee');
check('search returns listings with Gas equivalents', found.body.results[0]?.id === 'sf-0152' && found.body.results[0].gasEquivalent === 28_000);
const buyA = await J('POST', `/api/agents/${a}/bazaar/buy`, { solutionId: 'sf-0152', confidencePct: 80 });
check('checkout: PAID with a verified receipt, charge and stake', buyA.body.status === 'PAID' && buyA.body.receiptVerified && buyA.body.chargeId && buyA.body.stakeId, buyA.body.status + ' ' + (buyA.body.reasons || []).join(','));
const bondA = await reserved(a);
check('wallet: $28.00 charged, Score bond held', (await balance(a)) === 50_000n - 2_800n - bondA && bondA > 0n, `bond ${bondA}¢`);
const runA = await J('POST', `/api/agents/${a}/bazaar/run`, { receiptId: buyA.body.receiptId, input: { holdings: [{ value: 10_000, expense_ratio: 0.008 }] } });
check('run returns the solution output', runA.body.output?.annual_fee_drag === 80);
await J('POST', `/api/agents/${a}/bazaar/report`, { runId: runA.body.runId, success: true, observed: 80 });
const pend = await J('GET', `/api/agents/${a}/bazaar/pending`);
check('owner sees the provisional report', pend.body.pending?.some((p) => p.run_id === runA.body.runId));
await J('POST', `/api/agents/${a}/bazaar/attest`, { runId: runA.body.runId, verdict: 'confirm' });
const sA = await until(async () => { const s = await score(a); return s.wins === 1 && s.locked === 0 ? s : null; });
check('owner confirms → stake WON, bond released', !!sA && sA.balance > 1000 && (await reserved(a)) === 0n, sA && `score ${sA.balance}`);

console.log('\nB. External assistant (MCP) checks out with bazaar_* tools');
const conn = await J('POST', `/api/agents/${a}/connections`, { provider: 'chatgpt', scopes: ['context:read', 'wallet:read', 'bazaar:buy'], mandate: { maxPerTxMinor: 6_000, maxDailyMinor: 9_000, allowedServices: ['agentbazaar'] } });
const mcp = new Client({ name: 'e2e-assistant', version: '1.0.0' });
await mcp.connect(new StreamableHTTPClientTransport(new URL(PP + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${conn.body.token}` } } }));
const P = (r) => r.structuredContent ?? JSON.parse(r.content[0].text);
const tools = (await mcp.listTools()).tools.map((t) => t.name);
check('assistant sees bazaar_* tools, and no way to attest', ['bazaar_search', 'bazaar_buy', 'bazaar_run', 'bazaar_report'].every((t) => tools.includes(t)) && !tools.some((t) => /attest/.test(t)), tools.join(','));
const before = await score(a);
const buyB = P(await mcp.callTool({ name: 'bazaar_buy', arguments: { solution_id: 'sf-0201', confidence_pct: 95, intent_key: 'contract-review' } }));
check('bazaar_buy: PAID ($48) within the $60/payment mandate', buyB.status === 'PAID' && buyB.receiptVerified, buyB.status);
const over = P(await mcp.callTool({ name: 'bazaar_buy', arguments: { solution_id: 'sf-0163', confidence_pct: 70 } }));
check('connection’s daily cap ($90) blocks a further $55 purchase ($48 + $55)', over.reasons?.includes('MANDATE_DAILY_LIMIT'), over.reasons?.join(','));
const runB = P(await mcp.callTool({ name: 'bazaar_run', arguments: { receipt_id: buyB.receiptId } }));
P(await mcp.callTool({ name: 'bazaar_report', arguments: { run_id: runB.runId, success: true } }));
const walletBefore = (await balance(a)) + (await reserved(a));
await J('POST', `/api/agents/${a}/bazaar/attest`, { runId: runB.runId, verdict: 'dispute', note: 'flagged clauses were standard' });
const sB = await until(async () => { const s = await score(a); return s.losses === 1 && s.locked === 0 ? s : null; });
const lost = sB ? before.balance - sB.balance : 0;
check('owner disputes → stake LOST, points burned', !!sB && lost > 0, `-${lost} pts`);
check('the matching bond was forfeited in real money', walletBefore - (await balance(a)) === BigInt(lost), `-${lost}¢`);

console.log('\nC. Browser-style Bazaar agent with its own keys and a PayPali grant');
const c = await funded('owner-c@example.com', 30_000);
await J('POST', `/api/agentdev/agents/${c}/develop`, {});
await J('POST', `/api/agentdev/agents/${c}/capabilities`, { capability: 'bazaar.purchase', maxRisk: 'HIGH' });
const grant = (await J('POST', `/api/agents/${c}/merchant-grants`, { merchantId: 'agentbazaar', maxMinor: 15_000, currency: 'USD' })).body;
const H = new Identity(), A = new Identity();
const MPUB = (await (await fetch(BZ + '/.well-known/market-keys')).json()).keys[0].public_key;
await bzCall(BZ, H, 'POST', '/v1/principals', {});
const mand = makeMandate(H, A, { budget: 150, cap: 50, min_tier: 3, funding: { provider: 'paypali', grant_id: grant.grantId } });
const mr = await bzCall(BZ, H, 'POST', '/v1/mandates', { mandate: mand });
check('principal signs a mandate funded by the PayPali grant', mr.status === 200 && mr.body.funding?.paypali_agent_id === c);
const q = await bzCall(BZ, A, 'POST', '/v1/quote', { solution_id: 'sf-0233' }, mand.body.mid);
const pc = await bzCall(BZ, A, 'POST', '/v1/purchase', { quote_id: q.body.body.qid, confidence_pct: 75 }, mand.body.mid);
check('checkout: signed receipt with PayPali charge + stake', pc.status === 200 && verifyDoc(pc.body, MPUB) && !!pc.body.body.payment?.stake_id);
check('PayPali wallet charged $34.00', (await balance(c)) + (await reserved(c)) === 30_000n - 3_400n);
const rc = await bzCall(BZ, A, 'POST', '/v1/invoke', { receipt_id: pc.body.body.rid, input: { appliance: 'ev_charger' } }, mand.body.mid);
await bzCall(BZ, A, 'POST', '/v1/outcomes', { run_id: rc.body.run_id, success: true }, mand.body.mid);
await bzCall(BZ, H, 'POST', '/v1/outcomes/attest', { run_id: rc.body.run_id, verdict: 'confirm' });
const sC = await until(async () => { const s = await score(c); return s.wins === 1 && s.locked === 0 ? s : null; });
check('human confirms → the PayPali agent’s stake is WON', !!sC, sC && `score ${sC.balance}`);

console.log('\nD. Measured attestation (sf-0170 reports annual_gain in USD)');
const e = await funded('owner-e@example.com', 30_000);
await J('POST', `/api/agents/${e}/bazaar/enable`, { budgetMinor: 10_000, capMinor: 5_000 });
const buyE = await J('POST', `/api/agents/${e}/bazaar/buy`, { solutionId: 'sf-0170', confidencePct: 70 });
const runE = await J('POST', `/api/agents/${e}/bazaar/run`, { receiptId: buyE.body.receiptId, input: { cash: 10_000, apy_now: 0.01, apy_best: 0.05 } });
await J('POST', `/api/agents/${e}/bazaar/report`, { runId: runE.body.runId, success: true, observed: runE.body.output.annual_gain });
const oneClick = await J('POST', `/api/agents/${e}/bazaar/attest`, { runId: runE.body.runId, verdict: 'confirm' });
check('a one-click confirm is refused: the owner must enter what they observed', oneClick.status >= 400 && /observed_required/.test(JSON.stringify(oneClick.body)), JSON.stringify(oneClick.body));
const obs = await J('POST', `/api/agents/${e}/bazaar/attest`, { runId: runE.body.runId, observed: 0, note: 'no change on my statement' });
check('owner observed $0 vs agent $400 → failure, mismatch flagged', obs.body.final_success === false && obs.body.observation_mismatch === true, JSON.stringify({ s: obs.body.final_success, mm: obs.body.observation_mismatch }));
const sE = await until(async () => { const s = await score(e); return s.losses === 1 && s.locked === 0 ? s : null; });
check('…and the agent’s purchase stake settles LOST', !!sE);
const iss = await J('GET', '/.well-known/paypali-identity-issuer');
check('PayPali publishes its issuer key, assurance levels, KYC provider and revocation feed', iss.status === 200 && iss.body.id === 'paypali' && !!iss.body.assurances?.kyc && /identity-revocations$/.test(iss.body.revocations_url) && iss.body.kyc_provider === 'sandbox' && /PayPal/.test(iss.body.assurances.kyc));

console.log('\nE. Owner kill switch');
await J('POST', `/api/agents/${a}/bazaar/disable`, {});
const killed = await mcp.callTool({ name: 'bazaar_buy', arguments: { solution_id: 'sf-0170', confidence_pct: 70 } });
check('after disable, the connected assistant cannot buy (no silent re-enable)', killed.isError && P(killed).error === 'BAZAAR_DISABLED_BY_OWNER', P(killed).error);
await mcp.close();

console.log('\nF. KYC with PayPal: from one account to one verified PayPal account holder');
const ownerOf = async (id) => (await J('GET', '/api/agents/' + id)).body.ownerId;
const oA = await ownerOf(a), oC = await ownerOf(c), oE = await ownerOf(e);
const kycSandbox = async (ownerId, payerId) => {   // the sandbox page plays Log in with PayPal
  const st = await J('POST', `/api/owners/${ownerId}/kyc/sessions`, {});
  const r = await fetch(st.body.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outcome: 'approve', payerId }) });
  return (await r.json()).status;
};
check('owner A links a verified PayPal account (sandbox Log in with PayPal)', (await kycSandbox(oA, 'PAYERADA0001')) === 'VERIFIED');
const kA = await J('GET', `/api/owners/${oA}/kyc`);
check('PayPali now vouches for a PayPal-verified account holder (kyc assurance)', kA.body.assurance === 'kyc' && kA.body.verified === true, JSON.stringify(kA.body.assurance));
const reId = await J('POST', `/api/agents/${a}/bazaar/identity`, {});
check('the owner’s Bazaar principal is upgraded to a kyc credential', reId.body.assurance === 'kyc' && reId.body.countsAsEvidence === true, JSON.stringify(reId.body));
check('the same PayPal account cannot verify a second PayPali owner', (await kycSandbox(oC, 'payerada0001')) === 'DUPLICATE');
const rev = await fetch(`${PP}/api/admin/identity/${oE}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN }, body: JSON.stringify({ reason: 'chargeback fraud' }) });
const revBody = await rev.json();
const trustNow = await (await fetch(BZ + '/v1/trust')).json();
check('an admin revocation is signed, pushed, and applied by the Bazaar', rev.status === 200 && revBody.pushed >= 1 && trustNow.revoked_subjects >= 1, JSON.stringify(revBody));
const reE = await J('POST', `/api/agents/${e}/bazaar/identity`, {});
check('a revoked owner gets no new credentials', reE.status === 400 && reE.body.error === 'IDENTITY_REVOKED', JSON.stringify(reE.body));
const badAdmin = await fetch(`${PP}/api/admin/identity/${oA}/revoke`, { method: 'POST', headers: { 'x-admin-token': 'nope' }, body: '{}' });
check('revocation is admin-only', badAdmin.status === 404);

console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checkout checks passed');
if (fails) console.log(log.slice(-3000));
stop(fails ? 1 : 0);
