#!/usr/bin/env node
'use strict';
// Auditor / verifier kit: sign and submit third-party evidence to the marketplace (Node >= 20, zero deps).
//
//   node auditor-kit.js keygen                                     → {pkcs8, public_key}: register public_key in AUDITORS / VERIFIERS
//   node auditor-kit.js reproduce --solution sf-vXXXX --runs 20 --passed 19 [--vectors tests.json]
//   node auditor-kit.js audit     --solution sf-vXXXX --verdict pass|fail   [--findings report.pdf]
//   node auditor-kit.js measure   --run run_XXXX --solution sf-vXXXX --success true|false [--value 12.5]
//
// Common flags: --market http://127.0.0.1:8787   --id <your registered auditor/verifier id>
// The private key is read from KIT_KEY (PKCS#8, base64url) so it never appears in argv or shell history.
//
// What gets signed (canonical JSON, Ed25519):
//   reproduction {kind, auditor, solution_id, listing_hash, runs, passed, test_vector_hash, iat}
//   audit        {kind, auditor, solution_id, listing_hash, verdict, findings_hash, iat}
//   measurement  {kind, verifier, run_id, solution_id, success, value, iat}
// Reports bind to listing_hash (endpoint, schemas, metric, claim, runs, verifier). If the vendor changes any of it,
// the report stops counting and the marketplace answers 409 listing_changed with the new hash.
const fs = require('fs'), crypto = require('crypto');
const { Identity, signDoc, sha } = require('./client');

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2), v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; out[k] = v; } else out._.push(a);
  }
  return out;
}
const fileHash = f => f ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null;
const need = (o, ...ks) => { for (const k of ks) if (o[k] == null) throw new Error(`--${k} is required`); };

async function post(base, path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** Programmatic API (used by tests and scripts). */
async function submit({ market, key, id, kind, ...f }) {
  const me = key instanceof Identity ? key : Identity.fromPkcs8(key);
  const base = market.replace(/\/+$/, '');
  if (kind === 'measurement') {
    const doc = signDoc(me, { kind, verifier: id, run_id: f.run, solution_id: f.solution, success: f.success, value: f.value ?? null, iat: Date.now() });
    return post(base, '/v1/measurements', { measurement: doc });
  }
  const listing = await (await fetch(`${base}/v1/solutions/${encodeURIComponent(f.solution)}`)).json();
  if (!listing.listing_hash) throw new Error('listing has no hash (seed listings cannot be audited): ' + (listing.error || f.solution));
  const body = { kind, auditor: id, solution_id: f.solution, listing_hash: listing.listing_hash, iat: Date.now(),
    ...(kind === 'reproduction' ? { runs: f.runs, passed: f.passed, test_vector_hash: f.testVectorHash ?? null } : { verdict: f.verdict, findings_hash: f.findingsHash ?? null }) };
  return post(base, `/v1/solutions/${encodeURIComponent(f.solution)}/${kind === 'reproduction' ? 'reproductions' : 'audits'}`, { report: signDoc(me, body) });
}

async function main() {
  const o = args(process.argv.slice(2)), cmd = o._[0];
  if (cmd === 'keygen') { const k = new Identity(); console.log(JSON.stringify({ pkcs8: k.exportPkcs8(), public_key: k.pub }, null, 2)); return; }
  if (!['reproduce', 'audit', 'measure'].includes(cmd)) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 20).join('\n')); process.exit(cmd ? 1 : 0); }
  if (!process.env.KIT_KEY) throw new Error('set KIT_KEY to your PKCS#8 private key (base64url)');
  need(o, 'id');
  const market = o.market || 'http://127.0.0.1:8787', common = { market, key: process.env.KIT_KEY, id: o.id };
  let r;
  if (cmd === 'reproduce') { need(o, 'solution', 'runs', 'passed'); r = await submit({ ...common, kind: 'reproduction', solution: o.solution, runs: +o.runs, passed: +o.passed, testVectorHash: fileHash(o.vectors) }); }
  else if (cmd === 'audit') { need(o, 'solution', 'verdict'); r = await submit({ ...common, kind: 'audit', solution: o.solution, verdict: o.verdict, findingsHash: fileHash(o.findings) }); }
  else {
    need(o, 'run', 'solution', 'success');
    r = await submit({ ...common, kind: 'measurement', run: o.run, solution: o.solution, success: o.success === 'true', value: o.value != null ? +o.value : null });
  }
  console.log(r.status, JSON.stringify(r.body, null, 2));
  if (r.status !== 200) process.exit(1);
}

module.exports = { submit, sha };
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
