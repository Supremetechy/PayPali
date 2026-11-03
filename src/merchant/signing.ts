import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Merchant Connect signatures (HMAC-SHA256, shared per-merchant secret).
//
// Merchant -> PayPali API request:
//   x-paypali-merchant:  <merchantId>
//   x-paypali-timestamp: <unix ms>
//   x-paypali-signature: v1=<hex HMAC(secret, `${ts}.${METHOD}.${path+query}.${sha256hex(body)}`)>
//   Accepted within ±5 min. Every money-moving call is also idempotent, so a
//   replayed request inside the window returns the original result.
//
// PayPali -> merchant webhook:
//   x-paypali-event-id:  <eventId>
//   x-paypali-signature: t=<unix ms>,v1=<hex HMAC(secret, `${ts}.${eventId}.${sha256hex(body)}`)>
//   Receivers must check freshness and dedupe on event id.
// ---------------------------------------------------------------------------

export const SKEW_MS = 5 * 60_000;
export const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (secret: string, msg: string) => createHmac('sha256', secret).update(msg, 'utf8').digest('hex');

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export function signRequest(secret: string, ts: number, method: string, path: string, body: string): string {
  return 'v1=' + hmac(secret, `${ts}.${method.toUpperCase()}.${path}.${sha256hex(body)}`);
}

export function verifyRequest(
  secret: string,
  h: { ts: string | undefined; sig: string | undefined },
  method: string,
  path: string,
  body: string,
  now = Date.now()
): 'OK' | 'MISSING_SIGNATURE' | 'STALE_TIMESTAMP' | 'BAD_SIGNATURE' {
  if (!h.ts || !h.sig) return 'MISSING_SIGNATURE';
  const ts = Number(h.ts);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SKEW_MS) return 'STALE_TIMESTAMP';
  return safeEq(signRequest(secret, ts, method, path, body), h.sig) ? 'OK' : 'BAD_SIGNATURE';
}

export function signEvent(secret: string, ts: number, eventId: string, body: string): string {
  return `t=${ts},v1=` + hmac(secret, `${ts}.${eventId}.${sha256hex(body)}`);
}

export function verifyEvent(secret: string, header: string | undefined, eventId: string, body: string, now = Date.now()): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m) return false;
  const ts = Number(m[1]);
  if (Math.abs(now - ts) > SKEW_MS) return false;
  return safeEq(signEvent(secret, ts, eventId, body), header!);
}
