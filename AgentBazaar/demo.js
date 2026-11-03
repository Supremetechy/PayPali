'use strict';
// End-to-end run: identity, mandates, quote, purchase, invoke, outcomes, tier promotion, and attack cases.
const { start } = require('./server');
const { Identity, call, makeMandate, verifyDoc } = require('./client');
const { createVendorEndpoint } = require('./vendor-kit');
let fails = 0;
const check = (label, ok, extra) => { if (!ok) fails++; console.log((ok ? '  pass  ' : '  FAIL  ') + label + (extra ? '  [' + extra + ']' : '')); };

(async () => {
  const { server, url, mp } = await start(0, { tickMs: 3600e3 });
  const mk = await (await fetch(url + '/.well-known/market-keys')).json(), MPUB = mk.keys[0].public_key;

  async function setup(budget = 100, cap = 50, min_tier = 3) {
    const human = new Identity(), agent = new Identity();
    await call(url, human, 'POST', '/v1/principals', {});
    await call(url, human, 'POST', '/v1/principals/me/fund', { amount: 500 });
    const mandate = makeMandate(human, agent, { budget, cap, min_tier });
    const r = await call(url, human, 'POST', '/v1/mandates', { mandate });
    return { human, agent, mandate, mid: mandate.body.mid, reg: r };
  }
  const buy = async (a, sid) => {
    const q = await call(url, a.agent, 'POST', '/v1/quote', { solution_id: sid }, a.mid);
    if (q.status !== 200) return { q, p: null };   // the quote itself was refused (e.g. revoked mandate)
    const p = await call(url, a.agent, 'POST', '/v1/purchase', { quote_id: q.body.body.qid }, a.mid);
    return { q, p };
  };
  const useAndReport = async (a, receipt, results, attest) => {
    // agent runs and reports each result; the human then signs a verdict. `human` overrides the verdict (default: confirm).
    let last;
    for (const ok of results) {
      const run = await call(url, a.agent, 'POST', '/v1/invoke', { receipt_id: receipt.body.rid, input: { holdings: [{ value: 10000, expense_ratio: 0.008 }] } }, a.mid);
      await call(url, a.agent, 'POST', '/v1/outcomes', { run_id: run.body.run_id, success: ok, observed: ok ? 1 : 0 }, a.mid);
      if (attest !== false) last = await call(url, a.human, 'POST', '/v1/outcomes/attest', { run_id: run.body.run_id, verdict: attest || 'confirm' }, a.mid);
    }
    return last ? last.body : null;
  };

  console.log('\n1. Identity and spending authority');
  const A = await setup();
  check('mandate registered, 100 credits held from the principal', A.reg.status === 200 && A.reg.body.held === 100);
  const bad = JSON.parse(JSON.stringify(A.mandate)); bad.body.budget = 100000; bad.body.mid = 'm_tampered_1';
  const t = await call(url, A.human, 'POST', '/v1/mandates', { mandate: bad });
  check('tampered mandate (budget edited after signing) is rejected', t.status === 400 && t.body.error === 'bad_mandate_signature', t.body.error);
  const imposter = new Identity();
  const im = await call(url, imposter, 'POST', '/v1/quote', { solution_id: 'sf-0152' }, A.mid);
  check('a different key cannot use the agent’s mandate', im.status === 403 && im.body.error === 'agent_key_mismatch', im.body.error);
  const fixed = { nonce: 'replay-test-nonce-1' };
  await call(url, A.agent, 'POST', '/v1/quote', { solution_id: 'sf-0152' }, A.mid, fixed);
  const rp = await call(url, A.agent, 'POST', '/v1/quote', { solution_id: 'sf-0152' }, A.mid, fixed);
  check('replayed request nonce is rejected', rp.status === 401 && rp.body.error === 'replayed_nonce', rp.body.error);
  const stale = await call(url, A.agent, 'POST', '/v1/quote', { solution_id: 'sf-0152' }, A.mid, { ts: Date.now() - 5 * 60e3 });
  check('stale timestamp is rejected', stale.status === 401, stale.body.error);

  console.log('\n2. Mandate limits enforced by the marketplace');
  const over = await buy(A, 'sf-0163');
  check('quote flags a 55 cr solution as over the 50 cr cap', over.q.body.body.allowed === false && over.q.body.body.reasons.includes('over_per_purchase_cap'));
  check('purchase of it is refused', over.p.status === 403 && over.p.body.error === 'mandate_violation', over.p.body.reasons);
  const low = await buy(A, 'sf-0188');
  check('V1 solution refused under a V3 minimum', low.p.status === 403 && low.p.body.reasons.includes('below_min_verification_tier'), low.p.body.reasons);

  console.log('\n3. Quote, purchase, signed receipt, invoke');
  const ok = await buy(A, 'sf-0152');
  check('purchase succeeds within mandate', ok.p.status === 200, ok.p.body.body && ok.p.body.body.rid);
  check('receipt verifies offline with the marketplace public key', verifyDoc(ok.p.body, MPUB));
  const forged = JSON.parse(JSON.stringify(ok.p.body)); forged.body.price = 1;
  check('forged receipt (price edited) fails verification', !verifyDoc(forged, MPUB));
  const again = await call(url, A.agent, 'POST', '/v1/purchase', { quote_id: ok.q.body.body.qid }, A.mid);
  check('retrying the same quote returns the same receipt, no double charge', again.body.body.rid === ok.p.body.body.rid);
  const inv = await call(url, A.agent, 'POST', '/v1/invoke', { receipt_id: ok.p.body.body.rid, input: { holdings: [{ value: 10000, expense_ratio: 0.008 }] } }, A.mid);
  check('invoke returns vendor output', inv.status === 200 && inv.body.output.annual_fee_drag === 80, JSON.stringify(inv.body.output));
  const other = await setup();
  const steal = await call(url, other.agent, 'POST', '/v1/invoke', { receipt_id: ok.p.body.body.rid, input: {} }, other.mid);
  check('another agent cannot invoke with this receipt', steal.status === 403, steal.body.error);
  const steal2 = await call(url, other.agent, 'POST', '/v1/outcomes', { run_id: inv.body.run_id, success: true }, other.mid);
  check('another agent cannot report an outcome for this run', steal2.status === 403, steal2.body.error);

  console.log('\n4. Agent reports are provisional: they do not count until a human attests');
  const U = [await setup(), await setup(), await setup()];
  for (const u of U) await useAndReport(u, (await buy(u, 'sf-0201')).p.body, [true, true, true, true], false);   // agents report, nobody attests
  const unatt = (await (await fetch(url + '/v1/solutions/sf-0201')).json()).verification;
  check('12 agent-only reports from 3 principals: still V3, counted as provisional', unatt.tier === 3 && unatt.n === 0 && unatt.provisional === 12, `n=${unatt.n}, provisional=${unatt.provisional}`);
  const pend = await call(url, U[0].human, 'GET', '/v1/principals/me/pending');
  check('the human sees only their own agent’s pending reports', pend.body.pending.length === 4 && pend.body.pending.every(x => x.solution_id === 'sf-0201'));

  console.log('\n5. Human co-attestation drives V3 -> V4 (12 attested outcomes, 3+ principals)');
  const before = (await (await fetch(url + '/v1/solutions/sf-0152')).json()).verification.tier;
  await call(url, A.agent, 'POST', '/v1/outcomes', { run_id: inv.body.run_id, success: true }, A.mid);
  const a0 = await call(url, A.human, 'POST', '/v1/outcomes/attest', { run_id: inv.body.run_id, verdict: 'confirm' }, A.mid);
  check('attestation recorded, agent and human agree', a0.status === 200 && a0.body.agreed === true);
  const r1 = await useAndReport(A, ok.p.body, [true, true, true]);
  check('first principal: 4 attested outcomes, still V3', r1.tier_after === 3, 'n=' + r1.verification.n);
  const B = await setup(), C = await setup();
  const rb = await useAndReport(B, (await buy(B, 'sf-0152')).p.body, [true, true, true, true]);
  check('second principal: still V3', rb.tier_after === 3, 'n=' + rb.verification.n);
  const rc = await useAndReport(C, (await buy(C, 'sf-0152')).p.body, [true, true, true, false]);
  check('third principal pushes attested evidence over the bar: V3 -> V4', before === 3 && rc.tier_after === 4,
    `n=${rc.verification.n}, rate=${rc.verification.rate}, principals=${rc.verification.distinct_principals}`);
  const hist = (await (await fetch(url + '/v1/solutions/sf-0152')).json()).tier_history;
  check('tier change is stored with its evidence', hist.length === 1 && hist[0].to === 4);

  console.log('\n6. Gaming resistance');
  const Sy = await setup(300, 60);
  for (let i = 0; i < 3; i++) await useAndReport(Sy, (await buy(Sy, 'sf-0233')).p.body, [true, true, true, true]);
  const g = (await (await fetch(url + '/v1/solutions/sf-0233')).json()).verification;
  check('one principal attesting 12 perfect outcomes does NOT promote (only 4 count, 8 capped)', g.tier === 3 && g.attested === 12 && g.n === 4 && g.capped === 8 && g.distinct_principals === 1, `tier=${g.tier}, n=${g.n}, capped=${g.capped}`);
  const D = await setup(), rcD = (await buy(D, 'sf-0233')).p.body;
  const runD = await call(url, D.agent, 'POST', '/v1/invoke', { receipt_id: rcD.body.rid, input: {} }, D.mid);
  await call(url, D.agent, 'POST', '/v1/outcomes', { run_id: runD.body.run_id, success: true }, D.mid);
  const disp = await call(url, D.human, 'POST', '/v1/outcomes/attest', { run_id: runD.body.run_id, verdict: 'dispute', note: 'savings did not appear on my bill' }, D.mid);
  check('human dispute overrides the agent’s success claim', disp.status === 200 && disp.body.agreed === false && disp.body.final_success === false && disp.body.verification.disputed === 1, 'disputed=' + disp.body.verification.disputed);
  const wrong = await call(url, other.human, 'POST', '/v1/outcomes/attest', { run_id: runD.body.run_id, verdict: 'confirm' });
  check('a different principal cannot attest someone else’s run', wrong.status === 403 && wrong.body.error === 'not_your_run', wrong.body.error);
  const byAgent = await call(url, D.agent, 'POST', '/v1/outcomes/attest', { run_id: runD.body.run_id, verdict: 'confirm' }, D.mid);
  check('an agent key cannot attest its own report', byAgent.status === 403 && byAgent.body.error === 'unknown_principal', byAgent.body.error);
  const twice = await call(url, D.human, 'POST', '/v1/outcomes/attest', { run_id: runD.body.run_id, verdict: 'confirm' });
  check('an attestation cannot be changed or repeated', twice.status === 409, twice.body.error);
  const run2 = await call(url, D.agent, 'POST', '/v1/invoke', { receipt_id: rcD.body.rid, input: {} }, D.mid);
  const early = await call(url, D.human, 'POST', '/v1/outcomes/attest', { run_id: run2.body.run_id, verdict: 'confirm' });
  check('a human cannot attest before the agent has reported', early.status === 409 && early.body.error === 'no_outcome_to_attest', early.body.error);
  const dup = await call(url, A.agent, 'POST', '/v1/outcomes', { run_id: inv.body.run_id, success: true }, A.mid);
  check('an outcome cannot be reported twice for one run', dup.status === 409);
  console.log('\n7. Revocation');
  const R = await setup(100, 50);
  const bal0 = (await call(url, R.human, 'GET', '/v1/mandates/' + R.mid)).body.principal_balance;
  const rv = await call(url, R.human, 'POST', `/v1/mandates/${R.mid}/revoke`, {});
  check('principal revokes the mandate and the unspent hold is returned', rv.body.revoked && rv.body.principal_balance === bal0 + 100, 'balance ' + bal0 + ' -> ' + rv.body.principal_balance);
  const after = await buy(R, 'sf-0152');
  check('agent can no longer buy', after.q.status === 403 && after.q.body.error === 'mandate_revoked', after.q.body.error);

  console.log('\n8. Vendor listing: endpoint verification, listings start at V1, signed webhook invocation');
  const V = new Identity(), invoked = [];
  const ep = await createVendorEndpoint({ identity: V, marketBase: url, handlers: {
    'solution.invoke': async d => { invoked.push(d.run_id); return { output: { audited: true, items: (d.input.items || []).length } }; },
  } });
  const reg = await call(url, V, 'POST', '/v1/vendors', { display_name: 'Ledgerline Labs', webhook_url: ep.url });
  check('vendor registers; webhook endpoint proves control by signing the challenge', reg.status === 200 && !!reg.body.verified_at, reg.body.vendor_id || reg.body.error);
  const Liar = new Identity();
  const liarEp = await createVendorEndpoint({ identity: new Identity(), marketBase: url });   // signs with a different key
  const lr = await call(url, Liar, 'POST', '/v1/vendors', { display_name: 'Borrowed URL', webhook_url: liarEp.url });
  check('registering an endpoint you do not control is refused', lr.status === 400 && lr.body.detail === 'bad_vendor_signature', lr.body.detail);
  const ssrf = await call(url, Liar, 'POST', '/v1/vendors', { display_name: 'x', webhook_url: 'file:///etc/passwd' });
  check('non-http webhook URLs are refused', ssrf.status === 400, ssrf.body.error);
  const notV = await call(url, Liar, 'POST', '/v1/solutions', { name: 'Nope', category: 'Finance', price: 5, claimed_success: 0.9 });
  check('a key that is not a registered vendor cannot list', notV.status === 403 && notV.body.error === 'not_a_vendor', notV.body.error);
  const lst = await call(url, V, 'POST', '/v1/solutions', { name: 'Receipt Reconciler', category: 'Finance', price: 9.5, claimed_success: 0.95, blurb: 'Matches receipts to card lines.', runs_included: 2, tier: 4 });
  check('a listing cannot declare its own tier', lst.status === 200 && lst.body.verification.tier === 1 && lst.body.fulfillment === 'webhook', 'tier=' + (lst.body.verification && lst.body.verification.tier));
  const sid = lst.body.id;
  const found = (await (await fetch(url + '/v1/search?q=reconciler')).json()).results;
  check('the new listing is searchable with its vendor attached', found.length === 1 && found[0].vendor.display_name === 'Ledgerline Labs');
  const W = await setup(100, 50, 1);
  const wb = await buy(W, sid);
  check('purchase of a vendor listing returns a signed receipt', wb.p.status === 200 && verifyDoc(wb.p.body, MPUB));
  const wi = await call(url, W.agent, 'POST', '/v1/invoke', { receipt_id: wb.p.body.body.rid, input: { items: [1, 2, 3] } }, W.mid);
  check('invoke is delivered by signed webhook and the vendor-signed result returned', wi.status === 200 && wi.body.output.items === 3 && !!wi.body.delivery.vendor_sig, JSON.stringify(wi.body.output));
  check('the vendor saw exactly one invocation for that run', invoked.filter(x => x === wi.body.run_id).length === 1);
  await mp.tick();
  check('order.purchased notification delivered to the vendor', ep.log.some(e => e.type === 'order.purchased'));
  const me = await call(url, V, 'GET', '/v1/vendors/me');
  check('vendor dashboard shows listings and delivery log', me.status === 200 && me.body.listings.length === 1 && me.body.deliveries.some(d => d.type === 'solution.invoke' && d.ok));

  console.log('\n9. Webhook failure handling and listing control');
  await ep.close();                                                     // vendor goes down
  const down = await call(url, W.agent, 'POST', '/v1/invoke', { receipt_id: wb.p.body.body.rid, input: {} }, W.mid);
  check('an unreachable vendor returns 502 and does NOT consume a run', down.status === 502 && down.body.error === 'vendor_unavailable', down.body.detail);
  const rcNow = await call(url, W.agent, 'GET', '/v1/receipts/' + wb.p.body.body.rid);
  check('runs_left unchanged after the failed delivery', rcNow.body.runs_left === 1, 'runs_left=' + rcNow.body.runs_left);
  const F = new Identity(), forger = await createVendorEndpoint({ identity: F, marketBase: url, handlers: { 'solution.invoke': async () => ({ output: 'ok' }) } });
  await call(url, F, 'POST', '/v1/vendors', { display_name: 'Turncoat', webhook_url: forger.url });
  const fl = await call(url, F, 'POST', '/v1/solutions', { name: 'Turncoat Tool', category: 'Ops', price: 3, claimed_success: 0.8 });
  const FB = await setup(100, 50, 1), fbuy = await buy(FB, fl.body.id);
  forger.server.removeAllListeners('request');                         // vendor starts answering unsigned
  forger.server.on('request', (q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"output":"tampered"}'); });
  const forged2 = await call(url, FB.agent, 'POST', '/v1/invoke', { receipt_id: fbuy.p.body.body.rid, input: {} }, FB.mid);
  check('an unsigned/forged vendor response is rejected', forged2.status === 502 && forged2.body.detail === 'bad_vendor_signature', forged2.body.detail);
  await forger.close();
  const q1 = await call(url, W.agent, 'POST', '/v1/quote', { solution_id: sid }, W.mid);
  await call(url, V, 'PATCH', '/v1/solutions/' + sid, { price: 12 });
  const pc = await call(url, W.agent, 'POST', '/v1/purchase', { quote_id: q1.body.body.qid }, W.mid);
  check('a price change after quoting is refused, not silently charged', pc.status === 409 && pc.body.error === 'price_changed', pc.body.error);
  const tierEdit = await call(url, V, 'PATCH', '/v1/solutions/' + sid, { tier: 4 });
  check('vendors cannot edit tier', tierEdit.status === 400 && tierEdit.body.field === 'tier');
  const otherEdit = await call(url, F, 'PATCH', '/v1/solutions/' + sid, { price: 1 });
  check('vendors cannot edit another vendor’s listing', otherEdit.status === 404);
  await call(url, V, 'PATCH', '/v1/solutions/' + sid, { status: 'paused' });
  const hidden = (await (await fetch(url + '/v1/search?q=reconciler')).json()).results.length;
  const pq = await call(url, W.agent, 'POST', '/v1/quote', { solution_id: sid }, W.mid);
  check('a paused listing is hidden and cannot be quoted', hidden === 0 && pq.status === 409, pq.body.error);
  await liarEp.close();

  console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
  server.close(); process.exit(fails ? 1 : 0);
})();
