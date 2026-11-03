// PayPali + AgentBazaar, wired together for checkout testing.     npm run stack   (or: node scripts/dev-stack.mjs)
//
// Starts both servers with a freshly generated shared Merchant Connect secret:
//   PayPali    http://localhost:4000   (PAYPALI_PORT)   — wallets, Score, Gas, remote MCP at /mcp
//   AgentBazaar http://localhost:8787  (BAZAAR_PORT)    — storefront at /, paid through PayPali
// Then seeds a demo owner so every kind of buyer can check out immediately:
//   • a PayPali-built agent with AgentBazaar enabled            (HTTP: /api/agents/:id/bazaar/*)
//   • a bearer connection for an external assistant (MCP)       (bazaar_* and Gas tools)
//   • a PayPali grant for a browser agent on the storefront     (paste into "PayPali grant id")
// Flags: --no-seed   STACK_SANDBOX=0 (keep Gas service portals as placeholders)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createDataAgentServer, demoQuestions, DEMO_QUESTION_TYPES, newsletterQuestions, NEWSLETTER_QUESTION_TYPES } from './data-agent-kit.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// PayPal sandbox credentials (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET) and other settings from .env, if present.
if (existsSync(resolve(ROOT, '.env'))) process.loadEnvFile(resolve(ROOT, '.env'));
const PP_PORT = Number(process.env.PAYPALI_PORT ?? 4000);
const BZ_PORT = Number(process.env.BAZAAR_PORT ?? 8787);
const DATA_PORT = Number(process.env.DATA_AGENT_PORT ?? 8799);   // demo company data agent (Acme Freight)
const NEWS_PORT = Number(process.env.NEWSLETTER_PORT ?? 8798);   // demo publisher (The Agent Economy Brief)
const PP = `http://localhost:${PP_PORT}`, BZ = `http://localhost:${BZ_PORT}`;
const SECRET = randomBytes(24).toString('hex');
// Trust registries for this run (dev-only throwaway keys): PayPali as identity issuer, one auditor lab, one verifier.
const edKey = () => { const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'), pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') }; };
const ISSUER = edKey(), LAB = edKey(), METER = edKey();
const ADMIN_TOKEN = process.env.STACK_ADMIN_TOKEN ?? randomBytes(16).toString('hex');
const MIN_ASSURANCE = process.env.STACK_MIN_ASSURANCE ?? 'dev';   // set kyc to count only KYC-verified people
const SEED = !process.argv.includes('--no-seed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function SEED_EARLY() { return !process.argv.includes('--no-seed'); }
const portFree = (port) => new Promise((r) => { const s = net.createServer().once('error', () => r(false)).listen(port, () => s.close(() => r(true))); });
const PORT_VARS = { PayPali: 'PAYPALI_PORT', AgentBazaar: 'BAZAAR_PORT', 'Data agent': 'DATA_AGENT_PORT', Newsletter: 'NEWSLETTER_PORT' };
for (const [name, port] of [['PayPali', PP_PORT], ['AgentBazaar', BZ_PORT], ...(SEED_EARLY() ? [['Data agent', DATA_PORT], ['Newsletter', NEWS_PORT]] : [])]) {
  if (!(await portFree(port))) { console.error(`Port ${port} (${name}) is in use. Set ${PORT_VARS[name]} to another port.`); process.exit(1); }
}

const kids = [];
function run(tag, color, args, env) {
  const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (d) => d.toString().split('\n').filter((l) => l.trim()).forEach((l) => console.log(`\x1b[${color}m[${tag}]\x1b[0m ${l}`));
  p.stdout.on('data', out); p.stderr.on('data', out);
  p.on('exit', (code) => { if (!stopping) { console.error(`[${tag}] exited (${code}); stopping the stack.`); stop(1); } });
  kids.push(p);
}
let stopping = false;
function stop(code = 0) { stopping = true; kids.forEach((k) => k.kill()); process.exit(code); }
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

run('bazaar', 35, ['AgentBazaar/server.js'], {
  PORT: String(BZ_PORT), PAYPALI_URL: PP, PAYPALI_MERCHANT_ID: 'agentbazaar', PAYPALI_MERCHANT_SECRET: SECRET,
  IDENTITY_ISSUERS: JSON.stringify([{ id: 'paypali', public_key: ISSUER.pub, revocations_url: `${PP}/.well-known/paypali-identity-revocations` }]), MIN_IDENTITY_ASSURANCE: MIN_ASSURANCE,
  AUDITORS: JSON.stringify([{ id: 'dev-lab', public_key: LAB.pub, roles: ['reproduce', 'audit'] }]),
  VERIFIERS: JSON.stringify([{ id: 'dev-meter', public_key: METER.pub }]),
  ADMIN_TOKEN, REQUIRE_SELLER_AGENT: '1',
});
run('paypali', 36, ['scripts/serve.mjs'], {
  PORT: String(PP_PORT), PAYPALI_IDENTITY_ISSUER_KEY: ISSUER.pkcs8, PAYPALI_IDENTITY_ISSUER_ID: 'paypali',
  PAYPALI_KYC_PROVIDER: process.env.PAYPALI_KYC_PROVIDER ?? 'sandbox', PAYPALI_KYC_FINGERPRINT_KEY: randomBytes(32).toString('base64'),
  PAYPALI_ADMIN_TOKEN: ADMIN_TOKEN, PAYPALI_REQUIRE_PAYOUT_BINDING: '1', PAYPALI_PUBLIC_URL: process.env.PAYPALI_PUBLIC_URL ?? PP, AGENTBAZAAR_URL: BZ,
  PAYPALI_MERCHANTS: JSON.stringify([{ id: 'agentbazaar', secret: SECRET, webhookUrl: `${BZ}/v1/paypali/webhooks` }]),
  PAYPALI_SERVICE_SANDBOX: process.env.STACK_SANDBOX === '0' ? '0' : '1',
  PAYPALI_ALLOW_INSECURE_DATA_ENDPOINTS: '1', PAYPALI_DATA_SETTLE_INTERVAL_MS: process.env.PAYPALI_DATA_SETTLE_INTERVAL_MS ?? '15000',
  // The demo is fresh every run (keys above are per run); `npm start` is the persistent single server.
  PAYPALI_DATA_DIR: '', PAYPALI_DATABASE_URL: '',
  // Sample agents are seeded without a PayPal approval; everything you create in the UI goes through PayPal.
  PAYPALI_ALLOW_DEV_SEEDS: '1',
  PAYPALI_REQUIRE_POWER_OF_AGENCY: process.env.PAYPALI_REQUIRE_POWER_OF_AGENCY ?? '1',
  // Gas floats: one-minute epochs and a small target so the demo shows the price moving.
  PAYPALI_GAS_EPOCH_MS: process.env.PAYPALI_GAS_EPOCH_MS ?? '60000', PAYPALI_GAS_TARGET: process.env.PAYPALI_GAS_TARGET ?? '300', PAYPALI_FUNDING_INTERVAL_MS: process.env.PAYPALI_FUNDING_INTERVAL_MS ?? '15000',
});

async function ready(url) { for (let i = 0; i < 400; i++) { try { if ((await fetch(url)).ok) return true; } catch {} await sleep(150); } return false; }
if (!(await ready(`${PP}/api/session`)) || !(await ready(`${BZ}/.well-known/market-keys`))) { console.error('Servers did not start.'); stop(1); }

const J = async (method, path, body) => {
  const r = await fetch(PP + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
};
async function funded(seedMinor, objective, email = 'demo@paypali.local') {
  const g = await J('POST', '/api/generate', { owner: { email }, objective: { type: objective }, seed: { amountMinor: seedMinor, currency: 'USD', fundingSourceReference: 'vault_dev_demo' } });
  for (let i = 0; i < 80; i++) { const a = await J('GET', '/api/agents/' + g.agentId); if (Number(a.accounts?.[0]?.availableMinor) > 0) break; await sleep(150); }
  return g.agentId;
}

const line = '─'.repeat(78);
console.log(`\n${line}\n  PayPali + AgentBazaar are running (shared merchant secret generated for this run)\n${line}`);
console.log(`  Storefront (browser agents)  ${BZ}/`);
console.log(`  PayPali onboarding/dashboard ${PP}/   ${PP}/dashboard`);
console.log(`  Remote MCP (external agents) ${PP}/mcp`);
console.log(`\n  Trust registries (dev keys, valid for this run only)`);
console.log(`    identity issuer  paypali     ${PP}/.well-known/paypali-identity-issuer   (market counts: ${MIN_ASSURANCE} and above)`);
console.log(`    KYC via PayPal (sandbox)     curl -s -X POST ${PP}/api/owners/<ownerId>/kyc/sessions   → open the url, share a verified account → kyc assurance`);
console.log(`                                 (real PayPal: PAYPALI_KYC_PROVIDER=paypal PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… npm run stack)`);
console.log(`    revoke an identity           curl -X POST ${PP}/api/admin/identity/<ownerId>/revoke -H 'x-admin-token: ${ADMIN_TOKEN}' -H 'content-type: application/json' -d '{"reason":"fraud"}'`);
console.log(`    vendors                      need an identity credential for their key; payouts need POST ${PP}/api/owners/<ownerId>/payout-bindings {agentId, vendorPub}`);
console.log(`    auditor lab      dev-lab     KIT_KEY=${LAB.pkcs8} node AgentBazaar/auditor-kit.js reproduce --id dev-lab --market ${BZ} --solution <id> --runs 20 --passed 19`);
console.log(`    verifier         dev-meter   KIT_KEY=${METER.pkcs8} node AgentBazaar/auditor-kit.js measure --id dev-meter --market ${BZ} --run <run_id> --solution <id> --success true`);
console.log(`    market key rotation         curl -X POST ${BZ}/v1/admin/rotate-market-key -H 'x-admin-token: ${ADMIN_TOKEN}'`);

if (SEED) {
  try {
    const shopper = await funded(50_000, 'GROWTH');                     // $500
    await J('POST', `/api/agents/${shopper}/bazaar/enable`, { budgetMinor: 20_000, capMinor: 6_000 });
    const conn = await J('POST', `/api/agents/${shopper}/connections`, {
      provider: 'claude', label: 'Demo external assistant', scopes: ['context:read', 'wallet:read', 'market:read', 'gas:quote', 'gas:pay', 'bazaar:buy', 'data:query'],
      mandate: { maxPerTxMinor: 6_000, maxDailyMinor: 15_000, allowRecurring: true },
    });
    const browser = await funded(30_000, 'MAINTAIN', 'browser@paypali.local');   // own owner: one identity = one Bazaar principal                   // $300
    await J('POST', `/api/agentdev/agents/${browser}/develop`, {});
    await J('POST', `/api/agentdev/agents/${browser}/capabilities`, { capability: 'bazaar.purchase', maxRisk: 'HIGH' });
    const grant = await J('POST', `/api/agents/${browser}/merchant-grants`, { merchantId: 'agentbazaar', maxMinor: 15_000, currency: 'USD' });

    console.log(`\n  Demo owners: demo@paypali.local (agent 1, connection 2) · browser@paypali.local (grant 3)\n`);
    console.log(`  1) PayPali-built agent  ${shopper}   ($500, AgentBazaar enabled: $200 budget, $60/purchase)`);
    console.log(`     curl -s ${PP}/api/bazaar/search?q=fee`);
    console.log(`     curl -s -X POST ${PP}/api/agents/${shopper}/bazaar/buy -H 'content-type: application/json' -d '{"solutionId":"sf-0152","confidencePct":80}'`);
    console.log(`     then …/bazaar/run {receiptId}, …/bazaar/report {runId,success}, owner: …/bazaar/pending, …/bazaar/attest {runId,verdict}`);
    console.log(`\n  2) External assistant over MCP (same agent; mandate $60/payment, $150/day)`);
    console.log(`     claude mcp add --transport http paypali ${PP}/mcp --header "Authorization: Bearer ${conn.token}"`);
    console.log(`     tools: bazaar_search, bazaar_buy, bazaar_run, bazaar_report, estimate_gas, pay_with_gas, …`);
    console.log(`\n  3) Browser agent on the storefront: open ${BZ}/ and paste this PayPali grant id ($150 cap):`);
    console.log(`     ${grant.grantId}`);
    console.log(`     (set Minimum tier to V1 to buy vendor listings; owner attestations settle the PayPali Score stakes)`);
    const demoOwner = (await J('GET', '/api/agents/' + browser)).ownerId;
    console.log(`     For your attestations to count as evidence, paste a PayPali identity credential under "Identity" — get one with:`);
    console.log(`     curl -s -X POST ${PP}/api/owners/${demoOwner}/identity-credentials -H 'content-type: application/json' -d '{"principalPub":"<your human key from the storefront>"}'`);

    // 4) A company data agent: Acme Freight answers questions from its (synthetic) shipment database.
    const acme = await funded(10_000, 'MAINTAIN', 'acme@paypali.local');            // $100 for its accuracy stakes
    const acmeOwner = (await J('GET', '/api/agents/' + acme)).ownerId;
    const reg = await J('POST', `/api/owners/${acmeOwner}/data-agents`, {
      agentId: acme, slug: 'acme-freight', name: 'Acme Freight', endpointUrl: `http://localhost:${DATA_PORT}/paypali`, disputeWindowHours: 1,
      description: 'Shipment volumes, statuses and your own shipment history from Acme Freight. Answers only: no raw rows, no customer fields.',
    });
    const issuerPub = (await (await fetch(`${PP}/.well-known/paypali-identity-issuer`)).json()).public_key;
    const dataServer = createDataAgentServer({ secret: reg.endpointSecret, issuerPublicKey: issuerPub, questions: demoQuestions });
    await new Promise((r) => dataServer.listen(DATA_PORT, r));
    kids.push({ kill: () => dataServer.close() });
    await J('POST', `/api/owners/${acmeOwner}/data-agents/${reg.dataAgent.id}/verify`);
    for (const q of DEMO_QUESTION_TYPES) await J('PUT', `/api/owners/${acmeOwner}/data-agents/${reg.dataAgent.id}/question-types`, q);
    await J('POST', `/api/agentdev/agents/${shopper}/capabilities`, { capability: 'data.query', maxRisk: 'HIGH' });

    // 5) A publisher: "The Agent Economy Brief", a newsletter for agents. Its agent earns per answer and sweeps
    //    earnings above $10 to its beneficiary's PayPal (Payouts; sandbox when PayPal is configured).
    const pub = await funded(1_000, 'GROWTH', 'publisher@paypali.local');           // $10 working balance for its accuracy stakes
    const pubOwner = (await J('GET', '/api/agents/' + pub)).ownerId;
    const news = await J('POST', `/api/owners/${pubOwner}/data-agents`, {
      agentId: pub, slug: 'agent-economy-brief', name: 'The Agent Economy Brief', endpointUrl: `http://localhost:${NEWS_PORT}/paypali`, disputeWindowHours: 1,
      description: 'A weekly newsletter written for agents: what changed in agent payments, trust and data, and one action per item for your holder’s objective.',
    });
    const newsServer = createDataAgentServer({ secret: news.endpointSecret, issuerPublicKey: issuerPub, questions: newsletterQuestions });
    await new Promise((r) => newsServer.listen(NEWS_PORT, r));
    kids.push({ kill: () => newsServer.close() });
    await J('POST', `/api/owners/${pubOwner}/data-agents/${news.dataAgent.id}/verify`);
    for (const q of NEWSLETTER_QUESTION_TYPES) await J('PUT', `/api/owners/${pubOwner}/data-agents/${news.dataAgent.id}/question-types`, q);
    const beneficiary = process.env.PAYPAL_SANDBOX_BENEFICIARY || 'beneficiary@example.com';
    await J('PUT', `/api/agents/${pub}/beneficiary`, { receiver: beneficiary, keepMinor: 1_000, minPayoutMinor: 50, period: 'MANUAL' });

    // Every agent acts under a signed Power of Agency (required in this stack: PAYPALI_REQUIRE_POWER_OF_AGENCY=1).
    for (const id of [shopper, browser, acme, pub]) {
      const d = await J('GET', `/api/agents/${id}/power-of-agency`);
      await J('POST', `/api/agents/${id}/power-of-agency/sign`, { acceptedTermsSha256: d.draftTermsSha256 });
    }
    console.log(`\n  4) Company data agent: Acme Freight (acme@paypali.local) at http://localhost:${DATA_PORT}, listed at ${PP}/marketplace → Data agents`);
    console.log(`     curl -s ${PP}/api/data-agents`);
    console.log(`     curl -s -X POST ${PP}/api/agents/${shopper}/data/query -H 'content-type: application/json' -d '{"dataAgent":"acme-freight","questionType":"lane_volume","input":{"week":"2026-W44"},"purpose":"analytics","confidencePct":80}'`);
    console.log(`     MCP: data_agents, data_quote, data_query, data_subscribe (connection 2 has data:query and allow recurring on). Dispute window 1h, then batched settlement.`);
    console.log(`\n  5) Newsletter for agents: The Agent Economy Brief (publisher@paypali.local) at http://localhost:${NEWS_PORT}; earnings above $10 sweep to ${beneficiary}`);
    console.log(`\n  Demo scenarios (newsletter, bot locator, price finder, earn → pay beneficiary, kill switch):`);
    console.log(`     PAYPALI_URL=${PP} STACK_ADMIN_TOKEN=${ADMIN_TOKEN} npm run demo`);
    console.log(`\n  Funding: ${process.env.PAYPAL_CLIENT_ID ? 'PayPal ' + (process.env.PAYPAL_ENV === 'production' ? 'PRODUCTION' : 'sandbox') + ' (from .env): onboarding and “Add funds” open real PayPal' : 'dev (no PAYPAL_CLIENT_ID in .env): a local page stands in for PayPal'}`);

  } catch (e) {
    console.error('\n  Seeding failed:', e.message);
  }
}
console.log(`\n  Ctrl+C stops both servers. Data is in memory and resets on restart.\n${line}\n`);
