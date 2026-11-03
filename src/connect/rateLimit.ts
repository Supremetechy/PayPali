// ---------------------------------------------------------------------------
// In-memory sliding-window rate limiter.
//
// Keyed by whatever identifies the caller — for /mcp that is the authenticated
// connection id (so one connection's spikes never starve another), for the
// pre-auth OAuth endpoints the client IP. It is per-process and resets on
// restart; a multi-instance deployment should front it with a shared limiter
// (e.g. Redis), but this stops a single connection from hammering the endpoint.
// ---------------------------------------------------------------------------

export interface RateDecision {
  ok: boolean;
  /** Seconds until the caller may retry (0 when ok). */
  retryAfter: number;
  /** Requests still allowed in the current window. */
  remaining: number;
  limit: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private sweepAt = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Record one request against `key` and say whether it is allowed. */
  take(key: string): RateDecision {
    if (this.limit <= 0) return { ok: true, retryAfter: 0, remaining: Infinity, limit: this.limit };
    const t = this.now();
    const since = t - this.windowMs;
    this.maybeSweep(t);
    const arr = (this.hits.get(key) ?? []).filter((x) => x > since);
    if (arr.length >= this.limit) {
      const retryAfter = Math.max(1, Math.ceil((arr[0] + this.windowMs - t) / 1000));
      this.hits.set(key, arr);
      return { ok: false, retryAfter, remaining: 0, limit: this.limit };
    }
    arr.push(t);
    this.hits.set(key, arr);
    return { ok: true, retryAfter: 0, remaining: this.limit - arr.length, limit: this.limit };
  }

  /** Drop keys with no recent hits so the map can't grow without bound. */
  private maybeSweep(t: number): void {
    if (t < this.sweepAt) return;
    this.sweepAt = t + this.windowMs;
    const since = t - this.windowMs;
    for (const [k, arr] of this.hits) {
      const live = arr.filter((x) => x > since);
      if (live.length) this.hits.set(k, live); else this.hits.delete(k);
    }
  }
}

/** First hop of x-forwarded-for, else the socket address; used to key pre-auth limits. */
export function clientIp(req: { headers: Record<string, unknown>; socket?: { remoteAddress?: string } }): string {
  const xff = req.headers['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : typeof xff === 'string' ? xff.split(',')[0] : undefined;
  return (first ?? req.socket?.remoteAddress ?? 'unknown').trim();
}
