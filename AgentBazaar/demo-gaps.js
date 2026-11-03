'use strict';
// Trust + operations checks for the gaps closed after the first release (see README "Known gaps").
//   node demo-gaps.js
// A. measured attestation (human observed vs agent observed)      F. non-delivery refunds
// B. identity credentials from pluggable issuers                  G. input/output schema validation
// C. evidence weighting by price paid                             H. rate limits
// D. third-party verifier measurements                            I. principal, vendor and market key rotation
// E. reproduction + audit submissions bound to the listing hash
// K. issuer revocations (push + pull, retroactive)                L. vendors must hold a live identity
// M. payout accounts bound to the vendor's identity               N. DNS-rebinding-safe webhook egress
// O. encrypted persistence and restore
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { start, stateStore } = require('./server');
const { Identity, call, makeMandate, verifyDoc, signDoc, rotationProof } = require('./client');
const { createVendorEndpoint } = require('./vendor-kit');
let fails = 0;
const check = (label, ok, extra) => { if (!ok) fails++; console.log((ok ? '  pass  ' : '  FAIL  ') + label + (extra !== undefined ? '  [' + extra + ']' : '')); };

(async () => {
  const ISSUER = new Identity(), METER = new Identity(), METER2 = new Identity(), AU1 = new Identity(), AU2 = new Identity(), VSELF = new Identity();
  const trust = {
    identityIssuers: [{ id: 'paypali-dev', public_key: ISSUER.pub }], minAssurance: 'dev',
    verifiers: [{ id: 'meter-1', public_key: METER.pub }, { id: 'meter-2', public_key: METER2.pub }],
    auditors: [{ id: 'lab-a', public_key: AU1.pub }, { id: 'lab-b', public_key: AU2.pub }, { id: 'vendor-own-lab', public_key: VSELF.pub }],
    adminToken: 'admin-' + crypto.randomBytes(8).toString('hex'),
  };
  // The issuer's revocation feed (PayPali serves /.well-known/paypali-identity-revocations); the market pulls it.
  const feed = { revocations: [] };
  const feedSrv = require('http').createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(feed)); });
  await new Promise(r => feedSrv.listen(0, '127.0.0.1', r));
  trust.identityIssuers[0].revocations_url = `http://127.0.0.1:${feedSrv.address().port}/feed`;
  const { server, url, mp } = await start(0, { tickMs: 3600e3, payments: null, store: null, ...trust });
  const J = async (p) => (await fetch(url + p)).json();
  const listingOf = id => J('/v1/solutions/' + id);
  const cred = (who, subject, over = {}) => signDoc(over.signer || ISSUER, { kind: 'identity', issuer: 'paypali-dev', subject, principal_pub: (over.forKey || who).pub,
    level: 'human', assurance: 'dev', exp: Date.now() + 36e5, ...(over.body || {}) });
  let subjN = 0;
  async function buyer({ verified = true, budget = 500, cap = 100 } = {}) {
    const human = new Identity(), agent = new Identity();
    await call(url, human, 'POST', '/v1/principals', {});
    await call(url, human, 'POST', '/v1/principals/me/fund', { amount: 1000 });
    const subject = 'subject-' + (++subjN) + '-' + crypto.randomBytes(8).toString('hex');
    if (verified) await call(url, human, 'POST', '/v1/principals/me/identity', { credential: cred(human, subject) });
    const mandate = makeMandate(human, agent, { budget, cap, min_tier: 1 });
    await call(url, human, 'POST', '/v1/mandates', { mandate });
    return { human, agent, mandate, mid: mandate.body.mid, subject: verified ? subject : null };
  }
  const purchase = async (b, sid) => {
    const q = await call(url, b.agent, 'POST', '/v1/quote', { solution_id: sid }, b.mid);
    return call(url, b.agent, 'POST', '/v1/purchase', { quote_id: q.body.body.qid }, b.mid);
  };
  const invoke = (b, rid, input = {}) => call(url, b.agent, 'POST', '/v1/invoke', { receipt_id: rid, input }, b.mid);
  async function runReportAttest(b, rid, { success = true, observed, attest = { verdict: 'confirm' }, input } = {}) {
    const run = await invoke(b, rid, input);
    await call(url, b.agent, 'POST', '/v1/outcomes', { run_id: run.body.run_id, success, ...(observed !== undefined ? { observed } : {}) }, b.mid);
    const at = attest ? await call(url, b.human, 'POST', '/v1/outcomes/attest', { run_id: run.body.run_id, ...attest }) : null;
    return { run_id: run.body.run_id, at };
  }
  async function vendor(name, handlers = {}, identity = new Identity()) {
    const ep = await createVendorEndpoint({ identity, marketBase: url, handlers: { 'solution.invoke': async d => ({ output: { ok: true, n: Object.keys(d.input || {}).length } }), ...handlers } });
    await call(url, identity, 'POST', '/v1/principals', {});
    const subject = 'vendor-' + crypto.randomBytes(8).toString('hex');
    await call(url, identity, 'POST', '/v1/principals/me/identity', { credential: cred(identity, subject) });
    const r = await call(url, identity, 'POST', '/v1/vendors', { display_name: name, webhook_url: ep.url });
    return { id: identity, ep, subject, vendor_id: r.body.vendor_id, list: body => call(url, identity, 'POST', '/v1/solutions', { category: 'Finance', claimed_success: 0.9, ...body }) };
  }

  console.log('\nA. Measured attestation: the human records what they observed (sf-0170, metric annual_gain ≥ 0.01 USD)');
  const A = await buyer(), ra = await purchase(A, 'sf-0170');
  const a1 = await runReportAttest(A, ra.body.body.rid, { observed: 500, attest: { verdict: 'confirm' }, input: { cash: 10000, apy_now: 0.01, apy_best: 0.05 } });
  check('a metric listing refuses a one-click confirm without the human’s observed value', a1.at.status === 400 && a1.at.body.error === 'observed_required', a1.at.body.error);
  const a1b = await call(url, A.human, 'POST', '/v1/outcomes/attest', { run_id: a1.run_id, observed: 120 });
  check('human observed 120 vs agent 500: success by the human’s number, mismatch flagged', a1b.body.final_success === true && a1b.body.observation_mismatch === true && a1b.body.human_observed === 120, JSON.stringify({ s: a1b.body.final_success, mm: a1b.body.observation_mismatch }));
  const a2 = await runReportAttest(A, ra.body.body.rid, { observed: 400, attest: { observed: 0 } });
  check('agent claims success, human observed 0 → recorded as a failure', a2.at.body.final_success === false && a2.at.body.agreed === false);
  const a3 = await runReportAttest(A, ra.body.body.rid, { observed: 400, attest: { observed: 395 } });
  check('values within 10% are not a mismatch', a3.at.body.observation_mismatch === false);
  const pa = await listingOf('sf-0170');
  check('listing counts both mismatches (500 vs 120, 400 vs 0) and labels seed data', pa.verification.observation_mismatches === 2 && /seed/.test(pa.verification.basis), pa.verification.basis);

  console.log('\nB. Identity credentials (pluggable issuers; PayPali first)');
  const trustDoc = await J('/v1/trust');
  check('/v1/trust publishes issuers, verifiers, auditors and the evidence rules', trustDoc.identity_issuers[0].id === 'paypali-dev' && trustDoc.verified_evidence_required && trustDoc.max_outcomes_per_identity === 4 && trustDoc.verifiers.length === 2 && trustDoc.tax === 'not_calculated');
  const U = await buyer({ verified: false }), ru = await purchase(U, 'sf-0152');
  const n0 = (await listingOf('sf-0152')).verification.n;
  const u1 = await runReportAttest(U, ru.body.body.rid);
  check('an unverified human’s attestation is recorded but does not count', u1.at.body.counts_as_evidence === false && u1.at.body.verification.n === n0 && u1.at.body.verification.unverified_excluded === 1);
  const forged = await call(url, U.human, 'POST', '/v1/principals/me/identity', { credential: cred(U.human, 'subject-forged-xxxxxxxx', { signer: new Identity() }) });
  check('a credential not signed by a registered issuer is refused', forged.status === 400 && forged.body.error === 'bad_credential_signature', forged.body.error);
  const stolen = await call(url, U.human, 'POST', '/v1/principals/me/identity', { credential: cred(U.human, 'subject-someone-else-1', { forKey: new Identity() }) });
  check('a credential issued to another key cannot be presented', stolen.status === 400 && stolen.body.error === 'credential_not_for_this_key', stolen.body.error);
  const expired = await call(url, U.human, 'POST', '/v1/principals/me/identity', { credential: cred(U.human, 'subject-expired-12345', { body: { exp: Date.now() - 1000 } }) });
  check('an expired credential is refused', expired.status === 400 && expired.body.error === 'credential_expired', expired.body.error);
  const ok = await call(url, U.human, 'POST', '/v1/principals/me/identity', { credential: cred(U.human, 'subject-alice-0001') });
  check('a valid credential binds the principal to one subject', ok.status === 200 && ok.body.identity.counts_as_evidence === true);
  const sybil = new Identity(); await call(url, sybil, 'POST', '/v1/principals', {});
  const sy = await call(url, sybil, 'POST', '/v1/principals/me/identity', { credential: cred(sybil, 'subject-alice-0001') });
  check('the same person cannot back a second principal (sybil)', sy.status === 409 && sy.body.error === 'identity_already_bound', sy.body.error);
  const u2 = await runReportAttest(U, ru.body.body.rid);
  check('after verification, the same human’s attestation counts', u2.at.body.counts_as_evidence === true && u2.at.body.verification.n === n0 + 1, 'n=' + u2.at.body.verification.n);

  console.log('\nC. Evidence is weighted by the price actually paid');
  const VC = await vendor('Pennywise Tools');
  const cheap = await VC.list({ name: 'Penny Listing', price: 0.5, runs_included: 3 });
  const C1 = await buyer(), rc1 = await purchase(C1, cheap.body.id);
  await runReportAttest(C1, rc1.body.body.rid);
  check('one attested outcome at the listed price counts as 1.0', (await listingOf(cheap.body.id)).verification.n === 1);
  await call(url, VC.id, 'PATCH', '/v1/solutions/' + cheap.body.id, { price: 50 });
  const cw = (await listingOf(cheap.body.id)).verification;
  check('raising the price 100× reweights that evidence to 0.01 (farm-cheap-then-reprice buys nothing)', cw.n === 0.01, 'n=' + cw.n);

  console.log('\nD. Third-party verifier measurements');
  const VD = await vendor('Metered Savings Co');
  const md = await VD.list({ name: 'Metered Saver', price: 10, verifier_id: 'meter-1', outcome_metric: { name: 'kwh_saved', unit: 'kWh', direction: 'higher', success_threshold: 1 } });
  check('a listing can name a registered verifier', md.status === 200 && md.body.verifier_id === 'meter-1');
  const bogus = await VD.list({ name: 'Bogus', price: 10, verifier_id: 'nobody' });
  check('an unknown verifier is refused', bogus.status === 400 && bogus.body.error === 'unknown_verifier');
  const D1 = await buyer(), rd = await purchase(D1, md.body.id);
  const d1 = await runReportAttest(D1, rd.body.body.rid, { observed: 12, attest: { observed: 12 } });
  check('on a verifier listing, human attestation alone does not count', d1.at.status === 200 && d1.at.body.verification.n === 0, 'n=' + d1.at.body.verification.n);
  const meas = (signer, verifier, body = {}) => signDoc(signer, { kind: 'measurement', verifier, run_id: d1.run_id, solution_id: md.body.id, success: false, value: 0.2, iat: Date.now(), ...body });
  const mf = await fetch(url + '/v1/measurements', { method: 'POST', body: JSON.stringify({ measurement: meas(new Identity(), 'meter-1') }) });
  check('a measurement not signed by the verifier is refused', mf.status === 400);
  const mu = await fetch(url + '/v1/measurements', { method: 'POST', body: JSON.stringify({ measurement: meas(METER, 'meter-9') }) });
  check('an unregistered verifier is refused', mu.status === 403);
  const mo = await fetch(url + '/v1/measurements', { method: 'POST', body: JSON.stringify({ measurement: meas(METER2, 'meter-2') }) });
  check('a different registered verifier cannot measure this listing', mo.status === 403 && (await mo.json()).error === 'not_this_listings_verifier');
  const mr = await (await fetch(url + '/v1/measurements', { method: 'POST', body: JSON.stringify({ measurement: meas(METER, 'meter-1') }) })).json();
  check('the verifier’s measurement counts and overrides the human (measured failure)', mr.recorded && mr.verification.n === 1 && mr.verification.successes === 0 && mr.verification.measurement_disagreements === 1, JSON.stringify({ n: mr.verification.n, s: mr.verification.successes }));
  const m2 = await fetch(url + '/v1/measurements', { method: 'POST', body: JSON.stringify({ measurement: meas(METER, 'meter-1', { success: true }) }) });
  check('a run can only be measured once', m2.status === 409);

  console.log('\nE. Reproduction and audit submissions (V2/V3 earned, bound to the listing hash)');
  const VE = await vendor('Reproducible Inc', {}, VSELF);
  const le = await VE.list({ name: 'Audited Reconciler', price: 20, claimed_success: 0.9 });
  const h0 = le.body.listing_hash;
  const report = (signer, auditor, kind, extra = {}) => signDoc(signer, { kind, auditor, solution_id: le.body.id, listing_hash: h0, iat: Date.now(), ...extra });
  const post = async (kind, doc) => { const r = await fetch(`${url}/v1/solutions/${le.body.id}/${kind}`, { method: 'POST', body: JSON.stringify({ report: doc }) }); return { status: r.status, body: await r.json() }; };
  check('a new vendor listing starts at V1 (claimed)', le.body.verification.tier === 1 && le.body.verification.basis === 'claimed' && /^[0-9a-f]{64}$/.test(h0));
  const r1 = await post('reproductions', report(AU1, 'lab-a', 'reproduction', { runs: 20, passed: 19, test_vector_hash: 'tv1' }));
  check('a passing reproduction by a registered auditor → V2', r1.status === 200 && r1.body.tier_after === 2, r1.body.basis);
  const r2 = await post('reproductions', report(AU2, 'lab-b', 'reproduction', { runs: 20, passed: 10 }));
  check('a failing reproduction is recorded (pass=false) without promoting', r2.body.pass === false && r2.body.tier_after === 2);
  const a1x = await post('audits', report(AU1, 'lab-a', 'audit', { verdict: 'pass' }));
  check('an audit by the same lab that reproduced it does not reach V3', a1x.body.tier_after === 2);
  const self = await post('audits', report(VSELF, 'vendor-own-lab', 'audit', { verdict: 'pass' }));
  check('a vendor cannot audit its own listing', self.status === 403 && self.body.error === 'auditor_is_vendor', self.body.error);
  const forgedR = await post('audits', report(new Identity(), 'lab-b', 'audit', { verdict: 'pass' }));
  check('a report not signed by the named auditor is refused', forgedR.status === 400 && forgedR.body.error === 'bad_report_signature');
  const a2x = await post('audits', report(AU2, 'lab-b', 'audit', { verdict: 'pass' }));
  check('an audit by a second, different lab → V3', a2x.body.tier_after === 3, a2x.body.basis);
  const seedR = await fetch(url + '/v1/solutions/sf-0152/audits', { method: 'POST', body: JSON.stringify({ report: report(AU1, 'lab-a', 'audit', { verdict: 'pass', solution_id: 'sf-0152' }) }) });
  check('seed listings are not auditable (their tiers are labelled seed data)', seedR.status === 409);
  await call(url, VSELF, 'PATCH', '/v1/solutions/' + le.body.id, { runs_included: 9 });
  const after = await listingOf(le.body.id);
  check('changing what is sold changes the hash and lapses V2/V3 back to V1', after.verification.tier === 1 && after.listing_hash !== h0 && after.verification.reproductions.every(r => !r.current), 'tier=' + after.verification.tier);
  const staleR = await post('reproductions', report(AU1, 'lab-a', 'reproduction', { runs: 20, passed: 19 }));
  check('a report against the old hash is refused', staleR.status === 409 && staleR.body.error === 'listing_changed');
  const kit = await require('./auditor-kit').submit({ market: url, key: AU1, id: 'lab-a', kind: 'reproduction', solution: le.body.id, runs: 20, passed: 19 });
  check('auditor-kit re-reproduces the changed listing against its new hash → V2 again', kit.status === 200 && kit.body.tier_after === 2, kit.body.basis);

  console.log('\nF. Non-delivery refunds');
  const VF = await vendor('Flaky Vendor');
  const lf = await VF.list({ name: 'Sometimes Works', price: 15, runs_included: 2 });
  const F1 = await buyer(), rf = await purchase(F1, lf.body.id), rid = rf.body.body.rid;
  const early = await call(url, F1.agent, 'POST', `/v1/receipts/${rid}/refund`, {});
  check('no refund while the vendor is within its delivery window', early.status === 409 && early.body.reason === 'vendor_still_within_delivery_window', early.body.reason);
  await VF.ep.close();
  const f1 = await invoke(F1, rid), f2 = await invoke(F1, rid);
  check('two failed deliveries make the receipt refund-eligible', f1.body.refund_eligible === false && f2.body.refund_eligible === true);
  const m0 = (await call(url, F1.human, 'GET', '/v1/mandates/' + F1.mid)).body.remaining;
  const stranger = await call(url, new Identity(), 'POST', `/v1/receipts/${rid}/refund`, {});
  check('only the buyer’s agent or principal can claim the refund', stranger.status === 403);
  const rr = await call(url, F1.agent, 'POST', `/v1/receipts/${rid}/refund`, {});
  const m1 = (await call(url, F1.human, 'GET', '/v1/mandates/' + F1.mid)).body.remaining;
  check('refund issued and the mandate budget restored', rr.status === 200 && rr.body.refunded && m1 === m0 + 15, `${m0} → ${m1}`);
  const again = await call(url, F1.human, 'POST', `/v1/receipts/${rid}/refund`, {});
  check('a refund is idempotent', again.status === 200 && again.body.replayed === true);
  const dead = await invoke(F1, rid);
  check('a refunded receipt cannot be invoked', dead.status === 410 && dead.body.error === 'receipt_refunded');
  check('the listing carries the non-delivery', (await listingOf(lf.body.id)).verification.non_deliveries === 1);
  const rs = await purchase(F1, 'sf-0233');
  const notV = await call(url, F1.agent, 'POST', `/v1/receipts/${rs.body.body.rid}/refund`, {});
  check('market-fulfilled purchases are not refundable by this rule', notV.status === 409 && notV.body.reason === 'not_vendor_fulfilled');

  console.log('\nG. Input/output schema validation');
  let badOut = false;
  const VG = await vendor('Typed Tools', { 'solution.invoke': async d => ({ output: badOut ? { total: 'lots' } : { total: d.input.items.length } }) });
  const badSchema = await VG.list({ name: 'Regexy', price: 5, input_schema: { type: 'string', pattern: '^(a+)+$' } });
  check('unsupported schema keywords (e.g. pattern) are refused at listing time', badSchema.status === 400 && badSchema.body.detail === 'unsupported_keyword:pattern', badSchema.body.detail);
  const lg = await VG.list({ name: 'Item Counter', price: 5, runs_included: 3,
    input_schema: { type: 'object', required: ['items'], properties: { items: { type: 'array', maxItems: 3 } }, additionalProperties: false },
    output_schema: { type: 'object', required: ['total'], properties: { total: { type: 'integer', minimum: 0 } } } });
  const G1 = await buyer(), rg = await purchase(G1, lg.body.id);
  check('receipts carry an explicit tax placeholder', rg.body.body.tax.status === 'not_calculated');
  const gi = await invoke(G1, rg.body.body.rid, { items: [1, 2, 3, 4], extra: true });
  check('invalid input is refused before the vendor is called', gi.status === 400 && gi.body.error === 'input_invalid' && gi.body.errors.length === 2, (gi.body.errors || []).join('; '));
  const gv = await invoke(G1, rg.body.body.rid, { items: [1, 2] });
  check('valid input → vendor output validated and returned', gv.status === 200 && gv.body.output.total === 2 && gv.body.runs_left === 2);
  badOut = true;
  const gb = await invoke(G1, rg.body.body.rid, { items: [1] });
  check('output that breaks the vendor’s own contract is refused and does not consume a run', gb.status === 502 && gb.body.error === 'vendor_output_invalid', gb.body.error);
  const grc = await call(url, G1.agent, 'GET', '/v1/receipts/' + rg.body.body.rid);
  check('…and counts as a failed delivery', grc.body.runs_left === 2 && grc.body.failed_deliveries === 1);

  console.log('\nH. Rate limits');
  const rl = await start(0, { tickMs: 3600e3, payments: null, store: null, rateLimit: { capacity: 5, refillPerSec: 0.01 } });
  const L = new Identity(); let codes = [];
  for (let i = 0; i < 7; i++) codes.push((await call(rl.url, L, 'POST', '/v1/principals', {})).status);
  check('a key that exceeds its bucket gets 429', codes.slice(0, 5).every(c => c === 200) && codes[5] === 429, codes.join(','));
  const L2 = new Identity();
  check('other keys are unaffected', (await call(rl.url, L2, 'POST', '/v1/principals', {})).status === 200);
  rl.server.close();

  console.log('\nI. Key rotation');
  const P = await buyer(), P2 = new Identity();
  const pid = (await call(url, P.human, 'GET', '/v1/principals/me')).body.principal_id;
  const badProof = await call(url, P.human, 'POST', '/v1/principals/me/rotate', { new_pub: P2.pub, proof: rotationProof('principal', P.human, new Identity()) });
  check('rotation needs a proof signed by the new key', badProof.status === 400 && badProof.body.error === 'bad_rotation_proof');
  const rot = await call(url, P.human, 'POST', '/v1/principals/me/rotate', { new_pub: P2.pub, proof: rotationProof('principal', P.human, P2) });
  const oldK = await call(url, P.human, 'GET', '/v1/principals/me'), newK = await call(url, P2, 'GET', '/v1/principals/me');
  check('principal rotated: old key dead, new key is the same principal with its identity', rot.status === 200 && oldK.status === 403 && newK.body.principal_id === pid && newK.body.identity.counts_as_evidence);
  const rv = await call(url, P2, 'POST', `/v1/mandates/${P.mid}/revoke`, {});
  check('the new key controls mandates signed by the old one', rv.status === 200 && rv.body.revoked);
  const VI = await vendor('Rotating Vendor'), VI2 = new Identity();
  const li = await VI.list({ name: 'Rotator', price: 4 });
  VI.ep.rotate(VI2);
  const vr = await call(url, VI.id, 'POST', '/v1/vendors/me/rotate', { new_pub: VI2.pub, proof: rotationProof('vendor', VI.id, VI2) });
  const vOld = await call(url, VI.id, 'GET', '/v1/vendors/me'), vNew = await call(url, VI2, 'GET', '/v1/vendors/me');
  check('vendor rotated (endpoint proved the new key)', vr.status === 200 && vOld.status === 403 && vNew.body.vendor_id === VI.vendor_id && vNew.body.listings.length === 1, vr.body.error);
  const I1 = await buyer(), ri = await purchase(I1, li.body.id);
  const oldPub = mp.publicKey, oldReceipt = ri.body;
  const noAdmin = await fetch(url + '/v1/admin/rotate-market-key', { method: 'POST', headers: { 'x-admin-token': 'wrong' } });
  check('market key rotation is admin-only', noAdmin.status === 404);
  const mrot = await (await fetch(url + '/v1/admin/rotate-market-key', { method: 'POST', headers: { 'x-admin-token': trust.adminToken } })).json();
  const keys = (await J('/.well-known/market-keys')).keys;
  check('the old key stays published as retired', keys.length === 2 && keys.find(k => k.kid === mrot.retired_kid).status === 'retired' && keys.find(k => k.kid === mrot.active_kid).status === 'active');
  check('receipts signed before rotation still verify', verifyDoc(oldReceipt, oldPub) && oldReceipt.kid === mrot.retired_kid);
  const iv = await invoke(I1, ri.body.body.rid);
  check('vendor endpoints pick up the new market key automatically (kid refetch)', iv.status === 200 && !!iv.body.delivery.vendor_sig, iv.body.error || iv.body.detail);
  const ri2 = await purchase(I1, 'sf-0233');
  check('new receipts are signed by the new key', ri2.body.kid === mrot.active_kid && verifyDoc(ri2.body, mp.publicKey) && !verifyDoc(ri2.body, oldPub));

  const revoke = (subject, reason = 'fraud') => signDoc(ISSUER, { kind: 'revocation', issuer: 'paypali-dev', subject, reason, iat: Date.now() });
  const postRev = async doc => { const r = await fetch(url + '/v1/identity/revocations', { method: 'POST', body: JSON.stringify({ revocation: doc }) }); return { status: r.status, body: await r.json() }; };

  console.log('\nK. Issuer revocations (pushed and pulled) remove evidence retroactively');
  const nBefore = (await listingOf('sf-0152')).verification.n;
  const forgedRev = await postRev(signDoc(new Identity(), revoke('subject-alice-0001').body));
  check('a revocation not signed by the issuer is refused', forgedRev.status === 400 && forgedRev.body.error === 'bad_revocation');
  const rv1 = await postRev(revoke('subject-alice-0001', 'chargeback fraud'));
  const after1 = (await listingOf('sf-0152')).verification;
  check('a pushed revocation unbinds the principal and its past outcomes stop counting', rv1.body.principal_unbound && after1.n === nBefore - 1 && after1.revoked_excluded === 1, `n ${nBefore} → ${after1.n}`);
  const meU = await call(url, U.human, 'GET', '/v1/principals/me');
  check('the revoked principal no longer has an identity', meU.body.identity === null);
  const back = await call(url, U.human, 'POST', '/v1/principals/me/identity', { credential: cred(U.human, 'subject-alice-0001') });
  check('a revoked subject cannot be presented again', back.status === 403 && back.body.error === 'identity_revoked', back.body.error);
  check('re-sending a revocation is harmless', (await postRev(revoke('subject-alice-0001'))).body.duplicate === true);
  feed.revocations = [revoke(C1.subject, 'synthetic identity')];
  const pulled = await mp.pullRevocations();
  const cw2 = (await listingOf(cheap.body.id)).verification;
  check('the market pulls the issuer’s revocation feed', pulled === 1 && cw2.revoked_excluded === 1 && cw2.n === 0, `pulled=${pulled}, n=${cw2.n}`);

  console.log('\nL. Vendors must hold a live identity');
  const NoId = new Identity(), noIdEp = await createVendorEndpoint({ identity: NoId, marketBase: url });
  await call(url, NoId, 'POST', '/v1/principals', {});
  const noIdReg = await call(url, NoId, 'POST', '/v1/vendors', { display_name: 'Anonymous Shop', webhook_url: noIdEp.url });
  check('a key without an identity credential cannot register as a vendor', noIdReg.status === 403 && noIdReg.body.error === 'vendor_identity_required', noIdReg.body.error);
  const VL = await vendor('Lapsing Vendor'), ll = await VL.list({ name: 'Lapsing Tool', price: 6 });
  const L1 = await buyer(), q0 = await call(url, L1.agent, 'POST', '/v1/quote', { solution_id: ll.body.id }, L1.mid);
  check('a verified vendor sells normally', q0.status === 200 && (await listingOf(ll.body.id)).vendor.identity_verified === true);
  await postRev(revoke(VL.subject, 'vendor fraud'));
  const hiddenL = (await J('/v1/search?q=lapsing')).results.length;
  const ql = await call(url, L1.agent, 'POST', '/v1/quote', { solution_id: ll.body.id }, L1.mid);
  const pl = await call(url, L1.agent, 'POST', '/v1/purchase', { quote_id: q0.body.body.qid }, L1.mid);
  const vme = await call(url, VL.id, 'GET', '/v1/vendors/me');
  check('when the vendor’s identity is revoked its listings are hidden and cannot be quoted or bought', hiddenL === 0 && ql.status === 409 && ql.body.error === 'vendor_identity_lapsed' && pl.status === 409 && vme.body.selling === false);

  console.log('\nM. Payout accounts must be bound to the vendor’s identity');
  const VM = await vendor('Payout Vendor'), AGT = 'agt_payout_0001';
  const reg = body => call(url, VM.id, 'POST', '/v1/vendors', { display_name: 'Payout Vendor', webhook_url: VM.ep.url, payout_agent_id: AGT, ...body });
  const binding = (over = {}) => signDoc(ISSUER, { kind: 'payout_binding', issuer: 'paypali-dev', subject: VM.subject, vendor_pub: VM.id.pub, paypali_agent_id: AGT, iat: Date.now(), exp: Date.now() + 864e5, ...over });
  const nb = await reg({});
  check('a payout account without a binding is refused', nb.status === 400 && nb.body.error === 'payout_binding_required', nb.body.error);
  const mm1 = await reg({ payout_binding: binding({ paypali_agent_id: 'agt_someone_else' }) });
  check('a binding for another PayPali agent is refused', mm1.status === 400 && mm1.body.error === 'payout_binding_mismatch');
  const mm2 = await reg({ payout_binding: binding({ subject: 'subject-not-the-vendor-123' }) });
  check('a binding for a different person is refused (cannot route payouts to someone else’s account)', mm2.status === 403 && mm2.body.error === 'payout_binding_not_vendor_identity', mm2.body.error);
  const mm3 = await reg({ payout_binding: signDoc(new Identity(), binding().body) });
  check('a forged binding is refused', mm3.status === 400 && mm3.body.error === 'bad_payout_binding');
  const okb = await reg({ payout_binding: binding() });
  check('a valid binding verifies the payout account', okb.status === 200 && okb.body.payout_verified === true && okb.body.payout_hold === null, JSON.stringify(okb.body.payout_hold));
  const VM2 = new Identity(); VM.ep.rotate(VM2);
  await call(url, VM.id, 'POST', '/v1/vendors/me/rotate', { new_pub: VM2.pub, proof: rotationProof('vendor', VM.id, VM2) });
  const held = await call(url, VM2, 'GET', '/v1/vendors/me');
  check('after a vendor key rotation, payouts are held until the binding is re-issued', held.body.payout_verified === false && held.body.payout_hold === 'payout_binding_for_old_vendor_key', held.body.payout_hold);

  console.log('\nN. Webhook egress cannot be pointed at internal hosts (DNS rebinding)');
  const { createSafeFetch } = require('./safe-fetch');
  const blocked = async (f, u) => { try { await f(u, { method: 'POST', body: '{}' }); return 'allowed'; } catch (e) { return e.message; } };
  const mixed = createSafeFetch({ resolve: async () => ['93.184.216.34', '10.0.0.5'] });
  check('a name resolving to ANY private address is refused', (await blocked(mixed, 'https://shop.example/hook')) === 'egress_blocked:private');
  let lookups = 0, connectedTo = null;
  const EventEmitter = require('events');
  const fakeRequest = (o, cb) => { o.lookup(o.hostname, {}, (e, a) => { connectedTo = a; }); o.lookup(o.hostname, { all: true }, (e, list) => { connectedTo = connectedTo === list[0].address ? connectedTo : 'inconsistent'; });
    const req = new EventEmitter(); req.write = () => {}; req.end = () => { const res = new EventEmitter(); res.statusCode = 200; res.headers = {}; cb(res); res.emit('data', Buffer.from('{}')); res.emit('end'); }; req.destroy = () => {}; return req; };
  const rebinding = createSafeFetch({ resolve: async () => (++lookups === 1 ? ['93.184.216.34'] : ['127.0.0.1']), request: fakeRequest });
  const rb = await rebinding('https://rebind.example/hook', { method: 'POST', body: '{}' });
  await rebinding('https://rebind.example/hook', { method: 'POST', body: '{}' }).catch(() => {});
  check('rebinding: the connection is pinned to the address that was checked (one lookup per request)', rb.status === 200 && rb.connected_to === '93.184.216.34' && connectedTo !== '127.0.0.1');
  check('…and the next request, now resolving to 127.0.0.1, is refused', lookups === 2 && (await blocked(rebinding, 'https://rebind.example/hook')) === 'egress_blocked:loopback');
  const sf = createSafeFetch();
  const lits = await Promise.all(['https://127.0.0.1/x', 'https://[::ffff:169.254.169.254]/latest', 'https://[::1]/', 'https://0x7f000001/', 'http://example.com/', 'https://user:pw@example.com/'].map(u => blocked(sf, u)));
  check('literal internal addresses, metadata endpoints, plain http and credentials in URLs are refused', lits.every(r => r.startsWith('egress_blocked:')), lits.join(' | '));
  const guard = await start(0, { tickMs: 3600e3, payments: null, store: null, allowInsecureWebhooks: true, fetch: createSafeFetch({ resolve: async () => ['127.0.0.1'], allowHttp: true }) });
  const GV = new Identity(), gEp = await createVendorEndpoint({ identity: GV, marketBase: guard.url });
  const gReg = await call(guard.url, GV, 'POST', '/v1/vendors', { display_name: 'Rebinder', webhook_url: gEp.url.replace('127.0.0.1', 'rebind.example') });
  check('end to end: a vendor URL whose name resolves to loopback never gets a request', gReg.status === 400 && gReg.body.detail === 'egress_blocked:loopback' && gEp.log.length === 0, gReg.body.detail);
  guard.server.close(); await gEp.close(); await noIdEp.close();

  console.log('\nO. Encrypted persistence and restore');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bazaar-')), 'state.bin'), key = crypto.randomBytes(32).toString('hex');
  const st = stateStore(file, key); st.save(await mp.exportState());
  const disk = fs.readFileSync(file);
  check('the state file is encrypted (no plaintext ids or keys)', !disk.includes(Buffer.from(pid)) && !disk.includes(Buffer.from('pkcs8')));
  let wrongKey = false; try { stateStore(file, crypto.randomBytes(32).toString('hex')).load(); } catch { wrongKey = true; }
  check('the wrong STATE_KEY cannot open it', wrongKey);
  const r2s = await start(0, { tickMs: 3600e3, payments: null, store: st, ...trust });
  check('restart restores the same market keys', r2s.restored && r2s.mp.publicKey === mp.publicKey && r2s.mp.kid === mrot.active_kid);
  const before = await listingOf(md.body.id), restored = await (await fetch(r2s.url + '/v1/solutions/' + md.body.id)).json();
  check('listings, evidence and tiers survive', restored.verification.n === before.verification.n && restored.verification.measurement_disagreements === 1 && restored.verification.tier === before.verification.tier);
  const me2 = await call(r2s.url, P2, 'GET', '/v1/principals/me');
  check('rotated principals and their identity survive', me2.body.principal_id === pid && me2.body.identity.counts_as_evidence);
  const rcp = await call(r2s.url, G1.agent, 'GET', '/v1/receipts/' + rg.body.body.rid);
  check('receipts survive with runs and delivery counters', rcp.body.runs_left === 2 && rcp.body.failed_deliveries === 1 && verifyDoc(rcp.body, r2s.mp.marketKeys().find(k => k.kid === rcp.body.kid).pub));
  check('revocations survive a restart', (await (await fetch(r2s.url + '/v1/trust')).json()).revoked_subjects === 3);
  const dupSub = new Identity(); await call(r2s.url, dupSub, 'POST', '/v1/principals', {});
  const ds = await call(r2s.url, dupSub, 'POST', '/v1/principals/me/identity', { credential: cred(dupSub, P.subject) });
  check('one-subject-one-principal binding survives a restart', ds.status === 409);
  r2s.server.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true });

  for (const v of [VC, VD, VE, VG, VI, VL, VM]) await v.ep.close().catch(() => {});
  feedSrv.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll gap checks passed');
  server.close(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
