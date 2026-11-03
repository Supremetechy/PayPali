'use strict';
// End-to-end: AgentBazaar <-> PayPali with real ledger money and the Score gate.
// Boots the PayPali dev server (../scripts/serve.mjs) as a child process, the marketplace in-process, and a vendor endpoint.
//   node e2e-paypali.js          (from AgentBazaar/, after `npm install` in the PayPali root)
const { spawn } = require('child_process');
const net = require('net'), path = require('path'), crypto = require('crypto');
const { start } = require('./server');
const { Identity, call, makeMandate, verifyDoc } = require('./client');
const { createVendorEndpoint } = require('./vendor-kit');
const { createPayPaliPayments } = require('./paypali');

let fails = 0;
const check = (label, ok, extra) => { if (!ok) fails++; console.log((ok ? '  pass  ' : '  FAIL  ') + label + (extra !== undefined ? '  [' + extra + ']' : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function until(fn, ms = 8000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await sleep(150); } }

(async () => {
  const SECRET = crypto.randomBytes(24).toString('hex');
  const ppPort = await freePort(), PP = `http://127.0.0.1:${ppPort}`;
  const payments = createPayPaliPayments({ baseUrl: PP, merchantId: 'agentbazaar', secret: SECRET });
  const { server, url, mp } = await start(0, { payments, tickMs: 150 });
  const MPUB = (await (await fetch(url + '/.well-known/market-keys')).json()).keys[0].public_key;

  const pp = spawn(process.execPath, ['scripts/serve.mjs'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(ppPort), PAYPALI_WEBHOOK_INTERVAL_MS: '150',
      PAYPALI_MERCHANTS: JSON.stringify([{ id: 'agentbazaar', secret: SECRET, webhookUrl: url + '/v1/paypali/webhooks' }]) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ppLog = ''; pp.stdout.on('data', d => ppLog += d); pp.stderr.on('data', d => ppLog += d);
  const stop = code => { try { pp.kill(); } catch {} server.close(); process.exit(code); };
  const J = async (method, p, body) => { const r = await fetch(PP + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  if (!(await until(async () => { try { return (await fetch(PP + '/api/agents')).ok; } catch { return false; } }, 60000))) { console.error(ppLog); return stop(1); }

  const balance = async id => BigInt((await J('GET', '/api/agents/' + id)).body.accounts.find(a => a.currency === 'USD')?.availableMinor ?? 0);
  const reserved = async id => BigInt((await J('GET', '/api/agents/' + id)).body.accounts.find(a => a.currency === 'USD')?.reservedMinor ?? 0);
  const score = async id => (await J('GET', `/api/agentdev/agents/${id}/context`)).body.score;
  async function payPaliAgent(email, seedMinor) {
    const g = await J('POST', '/api/generate', { owner: { email }, objective: { type: 'GROWTH' }, seed: { amountMinor: seedMinor, currency: 'USD', fundingSourceReference: 'vault_dev' } });
    await until(async () => (await balance(g.body.agentId)) > 0n);
    return g.body.agentId;
  }

  console.log('\n1. PayPali side: buyer agent developed, bazaar.purchase granted, merchant grant issued');
  const buyerId = await payPaliAgent('buyer-owner@example.com', 50_000);        // $500 seed
  const vendorAgentId = await payPaliAgent('vendor-owner@example.com', 100);
  await J('POST', `/api/agentdev/agents/${buyerId}/develop`, {});
  await J('POST', `/api/agentdev/agents/${buyerId}/capabilities`, { capability: 'bazaar.purchase', maxRisk: 'HIGH' });
  const grant = (await J('POST', `/api/agents/${buyerId}/merchant-grants`, { merchantId: 'agentbazaar', maxMinor: 20_000, currency: 'USD' })).body;
  check('owner issued a $200 AgentBazaar grant', grant.status === 'ACTIVE' && grant.remainingMinor === '20000', grant.grantId);
  const startBal = await balance(buyerId);

  console.log('\n2. Bazaar side: vendor with a PayPali payout account lists a solution');
  const V = new Identity();
  const ep = await createVendorEndpoint({ identity: V, marketBase: url, handlers: { 'solution.invoke': async d => ({ output: { savings_found: 41.2, input_rows: (d.input.rows || []).length } }) } });
  const vr = await call(url, V, 'POST', '/v1/vendors', { display_name: 'Ledgerline Labs', webhook_url: ep.url, payout_agent_id: vendorAgentId });
  check('vendor verified with payout to its PayPali agent', vr.status === 200 && vr.body.payout_agent_id === vendorAgentId);
  const sid = (await call(url, V, 'POST', '/v1/solutions', { name: 'Subscription Leak Finder', category: 'Finance', price: 25, claimed_success: 0.9, runs_included: 3 })).body.id;

  console.log('\n3. Mandate funded by the PayPali grant');
  const H = new Identity(), A = new Identity();
  await call(url, H, 'POST', '/v1/principals', {});
  const unfunded = await call(url, H, 'POST', '/v1/mandates', { mandate: makeMandate(H, A, { budget: 100, cap: 50, min_tier: 1 }) });
  check('with payments on, an unfunded mandate is refused', unfunded.status === 400 && unfunded.body.error === 'funding_required', unfunded.body.error);
  const fake = await call(url, H, 'POST', '/v1/mandates', { mandate: makeMandate(H, A, { budget: 100, cap: 50, min_tier: 1, funding: { provider: 'paypali', grant_id: crypto.randomUUID() } }) });
  check('a grant id PayPali does not know is refused', fake.status === 402 && fake.body.error === 'grant_not_active', fake.body.error);
  const mand = makeMandate(H, A, { budget: 100, cap: 50, min_tier: 1, funding: { provider: 'paypali', grant_id: grant.grantId } });
  const mr = await call(url, H, 'POST', '/v1/mandates', { mandate: mand });
  check('signed mandate binds the grant (nothing held marketplace-side)', mr.status === 200 && mr.body.held === 0 && mr.body.funding.paypali_agent_id === buyerId);
  const mid = mand.body.mid;

  console.log('\n4. Purchase = Score-gated bazaar.purchase at PayPali');
  const q1 = await call(url, A, 'POST', '/v1/quote', { solution_id: sid }, mid);
  const noConf = await call(url, A, 'POST', '/v1/purchase', { quote_id: q1.body.body.qid }, mid);
  check('purchase without a stated confidence is refused before any money moves', noConf.status === 400 && noConf.body.error === 'confidence_pct_required');
  const p1 = await call(url, A, 'POST', '/v1/purchase', { quote_id: q1.body.body.qid, confidence_pct: 80 }, mid);
  check('purchase charged through PayPali; receipt carries charge + stake and verifies offline',
    p1.status === 200 && !!p1.body.body.payment.charge_id && !!p1.body.body.payment.stake_id && verifyDoc(p1.body, MPUB), p1.body.error);
  const held = await reserved(buyerId);
  check('buyer paid $25 and has a score bond on hold', (await balance(buyerId)) === startBal - 2500n - held && held > 0n, `bond=${held}`);
  const again = await call(url, A, 'POST', '/v1/purchase', { quote_id: q1.body.body.qid, confidence_pct: 80 }, mid);
  check('retrying the purchase does not charge twice', again.body.body.rid === p1.body.body.rid && (await balance(buyerId)) === startBal - 2500n - held);

  console.log('\n5. Delivery releases escrow to the vendor; human attestation settles the stake');
  const run1 = await call(url, A, 'POST', '/v1/invoke', { receipt_id: p1.body.body.rid, input: { rows: [1, 2] } }, mid);
  check('vendor delivered via signed webhook', run1.status === 200 && run1.body.output.savings_found === 41.2);
  check('vendor paid 90% ($22.50) to its PayPali agent after delivery', !!(await until(async () => (await balance(vendorAgentId)) === 100n + 2250n)), String(await balance(vendorAgentId)));
  const s0 = await score(buyerId);
  await call(url, A, 'POST', '/v1/outcomes', { run_id: run1.body.run_id, success: true }, mid);
  const at1 = await call(url, H, 'POST', '/v1/outcomes/attest', { run_id: run1.body.run_id, verdict: 'confirm' });
  check('attestation queues the stake settlement', at1.body.purchase_stake === 'settling');
  const s1 = await until(async () => { const s = await score(buyerId); return s.locked === 0 && s.wins === 1 ? s : null; });
  check('confirmed outcome: stake WON, bond released, score up', !!s1 && s1.balance > s0.balance && (await reserved(buyerId)) === 0n, s1 && `${s0.balance} -> ${s1.balance}`);
  const rcv = await call(url, A, 'GET', '/v1/receipts/' + p1.body.body.rid, null, mid);
  check('receipt shows payout and stake settlement', rcv.body.payout.status === 'paid' && rcv.body.stake_settlement.status === 'WON');

  console.log('\n6. Overconfident purchase that the human disputes');
  const q2 = await call(url, A, 'POST', '/v1/quote', { solution_id: sid }, mid);
  const p2 = await call(url, A, 'POST', '/v1/purchase', { quote_id: q2.body.body.qid, confidence_pct: 95 }, mid);
  const balBeforeLoss = await balance(buyerId) + await reserved(buyerId);
  const run2 = await call(url, A, 'POST', '/v1/invoke', { receipt_id: p2.body.body.rid, input: {} }, mid);
  await call(url, A, 'POST', '/v1/outcomes', { run_id: run2.body.run_id, success: true }, mid);
  await call(url, H, 'POST', '/v1/outcomes/attest', { run_id: run2.body.run_id, verdict: 'dispute', note: 'no leaks were real' });
  const s2 = await until(async () => { const s = await score(buyerId); return s.losses === 1 && s.locked === 0 ? s : null; });
  const lost = s1.balance - s2.balance;
  check('disputed outcome: stake LOST, points burned', !!s2 && lost > 0, `-${lost} pts`);
  check('the matching bond was forfeited in real money', balBeforeLoss - (await balance(buyerId)) === BigInt(lost), `-${lost}¢`);

  console.log('\n7. Money is conserved');
  await until(async () => (await balance(vendorAgentId)) === 100n + 4500n);
  const merchantBal = (await payments.balance('USD')).availableMinor;
  check('marketplace keeps its 10% fee: $5.00 across two sales', String(merchantBal) === '500', String(merchantBal));
  const g2 = (await payments.getGrant(grant.grantId));
  check('grant usage reflects both charges', g2.usedMinor === '5000', g2.usedMinor);

  console.log('\n8. Owner revokes the grant in PayPali -> webhook -> mandate revoked in the Bazaar');
  const grants = (await J('GET', `/api/agents/${buyerId}/merchant-grants`)).body.grants;
  await J('POST', `/api/merchant-grants/${grants[0].grantId}/revoke`, {});
  const revoked = await until(async () => (await call(url, H, 'GET', '/v1/mandates/' + mid)).body.revoked_by === 'paypali');
  check('grant.revoked webhook (HMAC-verified) revoked the mandate', !!revoked);
  const q3 = await call(url, A, 'POST', '/v1/quote', { solution_id: sid }, mid);
  check('the agent can no longer buy', q3.status === 403 && q3.body.error === 'mandate_revoked', q3.body.error);
  const forged = await fetch(url + '/v1/paypali/webhooks', { method: 'POST', headers: { 'content-type': 'application/json', 'x-paypali-event-id': 'evt_x', 'x-paypali-signature': 't=' + Date.now() + ',v1=' + '0'.repeat(64) }, body: '{"id":"evt_x","type":"grant.revoked","data":{}}' });
  check('a forged PayPali webhook is rejected', forged.status === 401);

  await ep.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll end-to-end checks passed');
  stop(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
