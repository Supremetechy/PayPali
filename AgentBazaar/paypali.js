'use strict';
// PayPali payments adapter for the marketplace (Node). Implements the interface core.js expects in opts.payments:
//   getGrant(id) -> {status, currency, agentId, remainingMinor, ...} | null
//   charge({grant_id, amount_minor, currency, idempotency_key, reference, intent_key, confidence_pct})
//        -> {status:'PAID'|'DECLINED', charge_id, stake_id, reasons, score_quote}   (throws on network/5xx: outcome unknown)
//   reportOutcome(charge_id, success, evidence) -> settlement
//   refund(charge_id, reason) -> {status:'REFUNDED', refundTransferId, ...}   (idempotent)
//   payout({to_agent_id, amount_minor, currency, idempotency_key, reference}) -> {payout_id, ...}
//   verifyWebhook(headers, raw) -> boolean
// Requests are signed per PayPali Merchant Connect (src/merchant/signing.ts):
//   x-paypali-signature: v1=HMAC_SHA256(secret, `${ts}.${METHOD}.${path}.${sha256hex(body)}`)
const crypto = require('crypto');

const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (secret, msg) => crypto.createHmac('sha256', secret).update(msg, 'utf8').digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const big = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
const SKEW = 5 * 60e3;

function createPayPaliPayments({ baseUrl, merchantId, secret, fetch: f = fetch, timeoutMs = 10000 }) {
  if (!baseUrl || !merchantId || !secret || secret.length < 16) throw new Error('PayPali adapter needs baseUrl, merchantId and a secret of 16+ chars');
  const base = baseUrl.replace(/\/+$/, '');

  async function req(method, path, body) {
    const raw = body === undefined ? '' : JSON.stringify(body, big);
    const ts = Date.now();
    const res = await f(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-paypali-merchant': merchantId, 'x-paypali-timestamp': String(ts),
        'x-paypali-signature': 'v1=' + hmac(secret, `${ts}.${method}.${path}.${sha(raw)}`) },
      body: raw || undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null; try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, json };
  }
  const fail = (what, r) => Object.assign(new Error(`paypali_${what}_failed:${r.status}:${r.json && r.json.error}`), { status: r.status, body: r.json });

  return {
    provider: 'paypali',

    async getGrant(grantId) {
      const r = await req('GET', '/api/merchant/grants/' + encodeURIComponent(grantId));
      if (r.status === 400 || r.status === 404) return null;
      if (r.status !== 200) throw fail('grant', r);
      return r.json;
    },

    async charge(p) {
      const r = await req('POST', '/api/merchant/charges', {
        grantId: p.grant_id, amountMinor: String(p.amount_minor), currency: p.currency, idempotencyKey: p.idempotency_key, reference: p.reference,
        score: { intentKey: p.intent_key, confidencePct: p.confidence_pct },
      });
      if (r.status === 200 || r.status === 402) {
        const j = r.json;
        return { status: j.status, charge_id: j.chargeId || null, stake_id: j.stakeId || null, reasons: j.reasons || [], score_quote: j.scoreQuote || null };
      }
      if (r.status === 400) return { status: 'DECLINED', reasons: [r.json && r.json.error || 'bad_request'] };
      throw fail('charge', r);   // 5xx / 401 / 409 in-progress: outcome unknown, caller retries the same key
    },

    async reportOutcome(chargeId, success, evidence) {
      const r = await req('POST', `/api/merchant/charges/${encodeURIComponent(chargeId)}/outcome`, { success, evidence });
      if (r.status !== 200) throw fail('outcome', r);
      return r.json;
    },

    async refund(chargeId, reason) {
      const r = await req('POST', `/api/merchant/charges/${encodeURIComponent(chargeId)}/refund`, { reason });
      if (r.status !== 200) throw fail('refund', r);
      return r.json;
    },

    async payout(p) {
      const r = await req('POST', '/api/merchant/payouts', {
        toAgentId: p.to_agent_id, amountMinor: String(p.amount_minor), currency: p.currency, idempotencyKey: p.idempotency_key, reference: p.reference || p.receipt_id, binding: p.binding,
      });
      if (r.status !== 200) throw fail('payout', r);
      return { payout_id: r.json.payoutId, transfer_id: r.json.transferId, replayed: r.json.replayed };
    },

    async balance(currency = 'USD') {
      const r = await req('GET', '/api/merchant/balance?currency=' + currency);
      if (r.status !== 200) throw fail('balance', r);
      return r.json;
    },

    /** PayPali -> marketplace webhook: x-paypali-signature = t=<ms>,v1=HMAC(secret, `${t}.${event_id}.${sha256(body)}`) */
    verifyWebhook(headers, raw) {
      const id = headers['x-paypali-event-id'], m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(headers['x-paypali-signature'] || '');
      if (!id || !m || Math.abs(Date.now() - +m[1]) > SKEW) return false;
      let parsed; try { parsed = JSON.parse(raw); } catch { return false; }
      if (parsed.id !== id) return false;
      return safeEq(`t=${m[1]},v1=` + hmac(secret, `${m[1]}.${id}.${sha(raw)}`), headers['x-paypali-signature']);
    },
  };
}

module.exports = { createPayPaliPayments };
