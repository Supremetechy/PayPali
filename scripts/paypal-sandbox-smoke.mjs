// PayPal sandbox smoke test: proves PayPali's PayPal calls work with YOUR sandbox app.
//
//   npm run paypal:smoke            (reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from .env)
//
// Steps (each prints PASS / FAIL / SKIP):
//   1. OAuth: client credentials → access token
//   2. Orders v2: create a $1.00 CAPTURE order the way PayPali funds an agent (asks to save PayPal)
//   3. You approve it in the browser with a sandbox PERSONAL account (the link opens automatically on macOS)
//   4. Capture: COMPLETED, amount matches, capture id; whether PayPal saved the account (vault)
//   5. Allowance: charge the saved PayPal $0.50 with no buyer present (needs vaulting enabled on the app)
//   6. Payouts: send $0.25 out, the way an agent pays a payee or its beneficiary
//
// Sandbox only unless you pass --production. No PayPali server needed. Nothing here touches real money
// in sandbox. Get credentials at developer.paypal.com → Apps & Credentials (Sandbox).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

if (existsSync(join(process.cwd(), '.env'))) process.loadEnvFile(join(process.cwd(), '.env'));
const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
const production = process.argv.includes('--production');
if (!id || !secret) {
  console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env (sandbox app from developer.paypal.com → Apps & Credentials).');
  process.exit(2);
}
if (process.env.PAYPAL_ENV === 'production' && !production) { console.error('PAYPAL_ENV=production: pass --production to really run against live PayPal.'); process.exit(2); }
const BASE = production ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const results = [];
const mark = (name, status, detail = '') => { results.push({ name, status, detail }); console.log(`${status === 'PASS' ? '\x1b[32mPASS\x1b[0m' : status === 'SKIP' ? '\x1b[33mSKIP\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? '  ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token;
async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', prefer: 'return=representation', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, debugId: r.headers.get('paypal-debug-id') };
}
const issue = (r) => `${r.status} ${r.json?.details?.[0]?.issue ?? r.json?.name ?? ''} ${r.json?.details?.[0]?.description ?? r.json?.message ?? ''} (debug ${r.debugId ?? '-'})`;

console.log(`PayPal ${production ? 'PRODUCTION' : 'sandbox'} smoke test against ${BASE}\n`);

// 1. OAuth
{
  const r = await fetch(BASE + '/v1/oauth2/token', { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { mark('OAuth client credentials', 'FAIL', `${r.status} ${j.error ?? ''} ${j.error_description ?? ''}`); process.exit(1); }
  token = j.access_token;
  const scopes = String(j.scope ?? '');
  mark('OAuth client credentials', 'PASS', `app ${j.app_id ?? ''}; payouts scope ${scopes.includes('payouts') ? 'present' : 'NOT in token (enable Payouts on the app)'}`);
}

// 2. Create the funding order
const ref = randomUUID();
const create = await call('POST', '/v2/checkout/orders', {
  intent: 'CAPTURE',
  purchase_units: [{ reference_id: 'paypali', custom_id: ref, description: 'PayPali smoke test: fund an agent', amount: { currency_code: 'USD', value: '1.00' } }],
  payment_source: { paypal: {
    experience_context: { brand_name: 'PayPali', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', return_url: 'http://localhost:4000/fund/return?smoke=1', cancel_url: 'http://localhost:4000/fund/return?smoke=1&cancel=1' },
    attributes: { vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT', customer_type: 'CONSUMER', permit_multiple_payment_tokens: true } },
  } },
}, { 'paypal-request-id': `smoke-${ref}` });
let orderId = create.json?.id;
let vaultRequested = true;
if (create.status >= 300 && /VAULT|PAYMENT_SOURCE|NOT_ENABLED|PERMISSION/i.test(issue(create))) {
  // The app can't save PayPal accounts: retry without the vault request so the rest still runs.
  mark('Create order with "save PayPal" (vault)', 'FAIL', issue(create) + ' → retrying without saving');
  vaultRequested = false;
  const again = await call('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE', purchase_units: [{ reference_id: 'paypali', custom_id: ref, amount: { currency_code: 'USD', value: '1.00' } }],
    payment_source: { paypal: { experience_context: { brand_name: 'PayPali', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', return_url: 'http://localhost:4000/fund/return?smoke=1', cancel_url: 'http://localhost:4000/fund/return?smoke=1&cancel=1' } } },
  }, { 'paypal-request-id': `smoke2-${ref}` });
  orderId = again.json?.id;
  if (again.status >= 300) { mark('Create order', 'FAIL', issue(again)); process.exit(1); }
  create.json = again.json;
}
const approve = (create.json?.links ?? []).find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
if (!orderId || !approve) { mark('Create order', 'FAIL', issue(create)); process.exit(1); }
mark('Create $1.00 CAPTURE order' + (vaultRequested ? ' (asks to save PayPal)' : ''), 'PASS', `${orderId} · ${create.json.status}`);

// 3. Owner approval
console.log(`\n  Approve it with a sandbox PERSONAL account (developer.paypal.com → Sandbox accounts):\n  ${approve}\n  After approving, PayPal sends you to localhost:4000 — that page may not load if PayPali isn't running; that's fine.\n`);
if (process.platform === 'darwin') spawn('open', [approve], { stdio: 'ignore', detached: true }).unref();
let approved = false;
for (let i = 0; i < 100; i++) {
  const g = await call('GET', `/v2/checkout/orders/${orderId}`);
  if (g.json?.status === 'APPROVED') { approved = true; break; }
  if (i % 10 === 0) process.stdout.write(`  waiting for approval… (${g.json?.status})\n`);
  await sleep(3000);
}
if (!approved) { mark('Owner approved at PayPal', 'FAIL', 'not approved within 5 minutes'); process.exit(1); }
mark('Owner approved at PayPal', 'PASS');

// 4. Capture
const cap = await call('POST', `/v2/checkout/orders/${orderId}/capture`, {}, { 'paypal-request-id': `smokecap-${ref}` });
const capture = cap.json?.purchase_units?.[0]?.payments?.captures?.[0];
if (cap.json?.status !== 'COMPLETED' || capture?.status !== 'COMPLETED') { mark('Capture', 'FAIL', issue(cap)); process.exit(1); }
const amountOk = capture.amount?.value === '1.00' && capture.amount?.currency_code === 'USD';
mark('Capture → credit the agent', amountOk ? 'PASS' : 'FAIL', `capture ${capture.id} · ${capture.amount?.value} ${capture.amount?.currency_code}${amountOk ? '' : ' (amount mismatch)'}`);
const payer = cap.json?.payment_source?.paypal ?? {};
const vault = payer.attributes?.vault;
if (!vaultRequested) mark('PayPal saved for allowances', 'SKIP', 'the app could not request vaulting');
else if (vault?.status === 'VAULTED' && vault.id) mark('PayPal saved for allowances', 'PASS', `vault ${vault.id}`);
else mark('PayPal saved for allowances', 'FAIL', `vault status ${vault?.status ?? 'missing'}: enable "Save payment methods" for this app (Apps & Credentials → app → Features). Allowances fall back to approve-each-period.`);

// 5. Allowance charge from the saved PayPal
if (vault?.status === 'VAULTED' && vault.id) {
  const ch = await call('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE', purchase_units: [{ reference_id: 'paypali', custom_id: `${ref}:allowance`, amount: { currency_code: 'USD', value: '0.50' } }],
    payment_source: { paypal: { vault_id: vault.id } },
  }, { 'paypal-request-id': `smokeallow-${ref}` });
  let st = ch.json?.status, c = ch.json?.purchase_units?.[0]?.payments?.captures?.[0];
  if (ch.status < 300 && st !== 'COMPLETED' && ch.json?.id) {
    const cc = await call('POST', `/v2/checkout/orders/${ch.json.id}/capture`, {}, { 'paypal-request-id': `smokeallowcap-${ref}` });
    st = cc.json?.status; c = cc.json?.purchase_units?.[0]?.payments?.captures?.[0];
  }
  mark('Allowance: charge saved PayPal, no buyer present', st === 'COMPLETED' && c?.status === 'COMPLETED' ? 'PASS' : 'FAIL', st === 'COMPLETED' ? `capture ${c?.id}` : issue(ch));
} else mark('Allowance: charge saved PayPal, no buyer present', 'SKIP', 'no saved PayPal');

// 6. Payouts
const receiver = process.env.PAYPAL_SANDBOX_PAYOUT_RECEIVER || payer.email_address;
if (!receiver) mark('Payouts: pay a payee / beneficiary', 'SKIP', 'set PAYPAL_SANDBOX_PAYOUT_RECEIVER');
else {
  const p = await call('POST', '/v1/payments/payouts', {
    sender_batch_header: { sender_batch_id: `smoke-${ref}`, email_subject: 'PayPali smoke test payout' },
    items: [{ recipient_type: 'EMAIL', amount: { value: '0.25', currency: 'USD' }, receiver, note: 'PayPali smoke test', sender_item_id: `smoke-${ref}` }],
  }, { 'paypal-request-id': `smokepayout-${ref}` });
  const batch = p.json?.batch_header?.payout_batch_id;
  mark('Payouts: pay a payee / beneficiary', p.status < 300 && batch ? 'PASS' : 'FAIL', batch ? `batch ${batch} → ${receiver} (${p.json.batch_header.batch_status})` : issue(p));
}

const failed = results.filter((r) => r.status === 'FAIL');
console.log(`\n${results.filter((r) => r.status === 'PASS').length} passed, ${failed.length} failed, ${results.filter((r) => r.status === 'SKIP').length} skipped.`);
if (failed.length) console.log('Failures above say which PayPal app setting to change. PayPali still works without vaulting (allowances ask for approval each period).');
process.exitCode = failed.length ? 1 : 0;
