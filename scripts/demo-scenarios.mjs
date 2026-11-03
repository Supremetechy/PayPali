// PayPali demo scenarios, narrated, against a running `npm run stack`.
//
//   PAYPALI_URL=http://localhost:4000 STACK_ADMIN_TOKEN=<from the stack banner> npm run demo
//
//   A. An agent subscribed to a newsletter: what it reads, what it pays, what its holder gets
//   B. Locate every bot that offers a capability: three sellers of the same function, bought on trust
//   C. Price finder: three travel finders, the agent buys the verified one and reports the saving
//   D. Earning a living for a beneficiary: the publisher's agent earns per answer and pays its human
//   E. Kill switch: one click stops an agent everywhere
//
// Each scenario prints what happened and why. Nothing here bypasses PayPali: every payment is
// Score-gated, inside a mandate, under a signed Power of Agency.
const PP = (process.env.PAYPALI_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const ADMIN = process.env.STACK_ADMIN_TOKEN ?? '';
const only = (process.argv[2] ?? '').toUpperCase();

const C = { b: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, ok: (s) => `\x1b[32m${s}\x1b[0m`, bad: (s) => `\x1b[31m${s}\x1b[0m`, c: (s) => `\x1b[36m${s}\x1b[0m` };
const usd = (minor) => `$${(Number(minor) / 100).toFixed(2)}`;
const gasUsd = (gas) => `$${(gas / 1000).toFixed(3)}`;
const say = (s = '') => console.log(s);
const step = (s) => console.log(`  ${C.c('›')} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function J(method, path, body, headers = {}) {
  const r = await fetch(PP + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status >= 400 && r.status !== 402) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}
const header = (k, t, why) => { say(); say(C.b(`━━ ${k}. ${t} ${'━'.repeat(Math.max(4, 70 - t.length))}`)); if (why) say(C.dim(`   ${why}`)); };

async function agents() { return (await J('GET', '/api/agents')).agents; }
async function byEmail(email) {
  const a = (await agents()).find((x) => x.ownerEmail === email);
  if (!a) throw new Error(`No agent for ${email}. Start the stack with seeding (npm run stack).`);
  return a;
}
async function balance(id) { const a = await J('GET', '/api/agents/' + id); return BigInt(a.accounts?.find((x) => x.currency === 'USD')?.availableMinor ?? 0); }
async function signPoA(id) { const d = await J('GET', `/api/agents/${id}/power-of-agency`); if (!d.active || d.changedSinceSigned) await J('POST', `/api/agents/${id}/power-of-agency/sign`, { acceptedTermsSha256: d.draftTermsSha256 }); }

/** A reader agent: funded with a demo seed, allowed to buy answers, under a signed Power of Agency. */
async function reader(n) {
  const email = `reader${n}@paypali.local`;
  let a = (await agents()).find((x) => x.ownerEmail === email);
  if (!a) {
    const g = await J('POST', '/api/generate', { owner: { email }, agentName: `Reader ${n}`, objective: { type: ['GROWTH', 'SUSTAIN', 'MAINTAIN'][n % 3] }, seed: { amountMinor: 2_000, currency: 'USD', fundingSourceReference: 'vault_dev_reader' } });
    for (let i = 0; i < 60 && (await balance(g.agentId)) === 0n; i++) await sleep(150);
    await J('POST', `/api/agentdev/agents/${g.agentId}/develop`, {});
    await J('POST', `/api/agentdev/agents/${g.agentId}/capabilities`, { capability: 'data.query', maxRisk: 'HIGH' });
    a = { id: g.agentId, objectiveType: ['GROWTH', 'SUSTAIN', 'MAINTAIN'][n % 3] };
  }
  await signPoA(a.id);
  return a;
}

// ---------------------------------------------------------------------------
async function newsletter() {
  header('A', 'An agent subscribed to a newsletter', 'The Agent Economy Brief is a data agent: agents subscribe with a monthly budget and pay per issue in Gas.');
  const me = await byEmail('demo@paypali.local');
  const poa = await J('GET', `/api/agents/${me.id}/power-of-agency`);
  step(`Agent ${C.b(me.name)} acts under Power of Agency ${poa.active ? 'v' + poa.active.version : C.bad('(none)')}; objective ${me.objectiveType}.`);
  step(`Duty #1: ${C.dim(poa.active?.terms?.duties?.[0] ?? '')}`);
  const sub = await J('POST', `/api/agents/${me.id}/data-subscriptions`, { dataAgent: 'agent-economy-brief', monthlyBudgetMinor: 500 });
  step(`Subscribed: ${usd(sub.monthlyBudgetMinor)} a month for this publisher (recurring is allowed by its holder's mandate).`);
  const issue = await J('POST', `/api/agents/${me.id}/data/query`, { dataAgent: 'agent-economy-brief', questionType: 'latest_issue', input: {}, purpose: 'agent_briefing', confidencePct: 85 });
  if (issue.status !== 'ANSWERED') throw new Error('latest_issue: ' + issue.status + ' ' + issue.reasons);
  step(`Issue #${issue.result.issue} "${issue.result.headline}" for ${issue.gas.price + issue.gas.fee} Gas (${usd(issue.amountMinor)}), receipt hash ${issue.receipt.body.result_sha256.slice(0, 12)}…`);
  for (const it of issue.result.items.slice(0, 3)) say(C.dim(`       • ${it.title}`));
  const brief = await J('POST', `/api/agents/${me.id}/data/query`, { dataAgent: 'agent-economy-brief', questionType: 'briefing_for_goal', input: { objective: me.objectiveType ?? 'GROWTH', interests: ['trust', 'income', 'safety'], max_items: 3 }, purpose: 'agent_briefing', confidencePct: 80 });
  step(`Personal briefing for ${brief.result?.objective}: ${brief.gas.price} Gas metered over ${brief.usage?.rows} items reviewed (+${brief.gas.fee} fee).`);
  // Trainable: the agent proposes what it learned; the holder approves it into the agent's knowledge.
  const owner = (await J('GET', '/api/agents/' + me.id)).ownerId;
  const mod = await J('POST', '/api/agentdev/modules', { ownerId: owner, name: 'Agent Economy Brief: takeaways', description: 'Actions my agent proposed from its newsletter' });
  await J('POST', `/api/agentdev/agents/${me.id}/modules`, { moduleId: mod.id });
  for (const it of brief.result.items) {
    await J('POST', `/api/agentdev/agents/${me.id}/facts/propose`, { moduleId: mod.id, statement: `${it.title}: ${it.action}`, source: `agent-economy-brief/${issue.result.issue}` });
    say(C.dim(`       + proposed to holder: ${it.action}`));
  }
  step('Benefits: the agent learns what changed in its market for cents, the holder approves what it keeps, and the publisher knows exactly which agents read it.');
  // More readers for scenario D.
  for (const n of [1, 2, 3]) {
    const r = await reader(n);
    await J('POST', `/api/agents/${r.id}/data-subscriptions`, { dataAgent: 'agent-economy-brief', monthlyBudgetMinor: 300 });
    await J('POST', `/api/agents/${r.id}/data/query`, { dataAgent: 'agent-economy-brief', questionType: 'latest_issue', input: {}, purpose: 'agent_briefing', confidencePct: 80 });
    await J('POST', `/api/agents/${r.id}/data/query`, { dataAgent: 'agent-economy-brief', questionType: 'briefing_for_goal', input: { objective: r.objectiveType ?? 'SUSTAIN', max_items: 2 }, purpose: 'agent_briefing', confidencePct: 80 });
  }
  step('Three more reader agents subscribed and read this week’s issue.');
}

// ---------------------------------------------------------------------------
async function buyOnTrust(k, title, why, category, input, describe) {
  header(k, title, why);
  const me = await byEmail('demo@paypali.local');
  const { results } = await J('GET', `/api/bazaar/search?category=${encodeURIComponent(category)}`);
  if (!results.length) throw new Error(`No ${category} listings: restart the stack so AgentBazaar loads the new seed catalog.`);
  say(C.dim('     seller          tier  claims  observed  price'));
  for (const l of results) say(C.dim(`     ${String(l.vendor ?? l.name).padEnd(15)} V${l.tier}    ${Math.round(l.claimedSuccess * 100)}%     ${l.observedRate == null ? ' –  ' : Math.round(l.observedRate * 100) + '%'}     ${usd(l.priceMinor)}`));
  // The agent's rule: never buy unverified (V1) claims; among the rest, best evidence first, then price.
  const pick = results.filter((l) => l.tier >= 2).sort((a, b) => b.tier - a.tier || (b.observedRate ?? b.claimedSuccess) - (a.observedRate ?? a.claimedSuccess) || a.priceMinor - b.priceMinor)[0];
  const cheapest = results.slice().sort((a, b) => a.priceMinor - b.priceMinor)[0];
  step(`Picks ${C.b(pick.vendor)} (V${pick.tier}) over the cheapest, ${cheapest.vendor} (V${cheapest.tier}, ${Math.round(cheapest.claimedSuccess * 100)}% claimed, no evidence).`);
  const buy = await J('POST', `/api/agents/${me.id}/bazaar/buy`, { solutionId: pick.id, confidencePct: 80, intentKey: `demo:${pick.id}:${Date.now()}` });
  if (buy.status !== 'PAID') throw new Error(`buy ${pick.id}: ${buy.status} ${(buy.reasons || []).join(',')}`);
  step(`Paid ${usd(pick.priceMinor)} through PayPali under a Score stake; receipt ${buy.receiptVerified ? 'signature verified' : 'received'}.`);
  const run = await J('POST', `/api/agents/${me.id}/bazaar/run`, { receiptId: buy.receiptId, input });
  const out = run.output ?? run.result ?? run;
  describe(out);
  const observed = typeof out?.saving_vs_median === 'number' ? out.saving_vs_median : undefined;
  const rep = await J('POST', `/api/agents/${me.id}/bazaar/report`, { runId: run.runId ?? run.run_id, success: true, ...(observed !== undefined ? { observed } : {}) });
  step(`Reported the outcome${observed !== undefined ? ` (saved $${observed} vs the median quote)` : ''}; the holder confirms or disputes it, which settles the stake and builds ${pick.vendor}'s track record.`);
}

const locator = () => buyOnTrust('B', 'Locate every bot that offers a capability', 'Three sellers offer the same function. Each is verified differently, which sets its trust tier and its value.',
  'Agent discovery', { capability: 'invoice_reconciliation' }, (o) => {
    const found = o.found ?? [];
    step(`Found ${found.length} agents for "${o.capability}" across ${o.checked_sources} sources; ${found.filter((b) => b.verified).length} identity-verified.`);
    for (const b of found.slice(0, 3)) say(C.dim(`       • ${b.name} (${b.protocol}) ${b.endpoint} · ${b.price_per_call_gas} Gas/call · ${b.trust}`));
  });

const priceFinder = () => buyOnTrust('C', 'Price finder: best flight + hotel', 'Three finders search travel sites for the same trip; the agent buys the one with the best verified record. (Fares are simulated.)',
  'Travel', { origin: 'JFK', destination: 'LAX', depart: '2026-12-12', nights: 3 }, (o) => {
    step(`Best for ${o.route}, ${o.nights} nights: $${o.best.total_usd} (flight $${o.best.flight_usd} + hotel $${o.best.hotel_usd}) via ${o.best.source}, ${o.compared} sources compared.`);
  });

// ---------------------------------------------------------------------------
async function earn() {
  header('D', 'Earning a living for a beneficiary', 'The publisher’s agent sells answers to other agents and pays everything above its working balance to its human.');
  const pub = await byEmail('publisher@paypali.local');
  const listing = await J('GET', '/api/data-agents/agent-economy-brief');
  step(`${listing.stats.answered + listing.stats.settled} paid answers so far; observed accuracy ${listing.stats.observedAccuracy == null ? '–' : Math.round(listing.stats.observedAccuracy * 100) + '%'}.`);
  if (ADMIN) {
    const s = await J('POST', '/api/admin/data-agents/agent-economy-brief/settle-now', {}, { 'x-admin-token': ADMIN });
    step(`Settlement (demo: dispute windows closed early): ${s.queries} answers in ${s.batches} batch(es).`);
    step(`Publisher agent earned ${usd(s.paidToCompanyMinor)}; PayPali's fee was ${usd(s.feeMinor)}. Its accuracy stakes were won and their bonds released.`);
  } else step(C.dim('Set STACK_ADMIN_TOKEN to settle now; otherwise answers settle after the 1-hour dispute window.'));
  step(`Publisher agent balance ${usd(await balance(pub.id))}; it keeps $10.00 to stake on its answers.`);
  const sw = await J('POST', `/api/agents/${pub.id}/beneficiary/sweep`, {});
  if (sw.status === 'PAID') step(C.ok(`Paid ${usd(sw.amountMinor)} to beneficiary ${sw.receiver} through PayPal Payouts (batch ${sw.providerRef}).`));
  else step(`Sweep: ${sw.status}${sw.reason ? ' · ' + sw.reason : ''}${sw.status === 'NOTHING_TO_PAY' ? ' (earnings below the payout minimum: run the newsletter scenario again)' : ''}`);
}

// ---------------------------------------------------------------------------
async function killSwitch() {
  header('E', 'Kill switch', 'One owner action stops an agent everywhere at once.');
  const r = await reader(3);
  const stop = await J('POST', `/api/agents/${r.id}/stop`, { reason: 'Demo: holder pressed stop' });
  step(`Stopped Reader 3: ${Object.entries(stop.effects).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  const q = await J('POST', `/api/agents/${r.id}/data/query`, { dataAgent: 'agent-economy-brief', questionType: 'latest_issue', input: {}, purpose: 'agent_briefing', confidencePct: 80 });
  step(`It tries to buy an issue: ${C.bad(q.status)} (${q.reasons.join(', ')}). No money moved.`);
  const back = await J('POST', `/api/agents/${r.id}/resume`, {});
  step(`Resumed. ${back.next[0]}`);
  await signPoA(r.id);
  step('Holder re-signed its Power of Agency; the agent can act again.');
}

const all = { A: newsletter, B: locator, C: priceFinder, D: earn, E: killSwitch };
try {
  const cfg = await J('GET', '/api/funding/config');
  say(C.b(`PayPali demo against ${PP}`) + C.dim(`  (funding provider: ${cfg.provider})`));
  for (const [k, fn] of Object.entries(all)) if (!only || only.includes(k)) await fn();
  say(); say(C.ok('All scenarios finished.'));
} catch (e) {
  say(); say(C.bad(`Demo stopped: ${e.message}`));
  process.exitCode = 1;
}
