import { randomBytes } from 'node:crypto';
import { BazaarKey, sha256hex } from './keys';

// Thin signed HTTP client for the AgentBazaar API (protocol in AgentBazaar/README.md):
//   X-Key, X-Ts, X-Nonce, X-Sig = Ed25519( METHOD \n path+query \n ts \n nonce \n sha256hex(body) ), plus X-Mandate for agent calls.

export interface BazaarResponse<T = any> {
  status: number;
  body: T;
}

export class BazaarClient {
  private marketPub: string | null = null;

  constructor(readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 15_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async call<T = any>(key: BazaarKey | null, method: 'GET' | 'POST', path: string, body?: unknown, mandateId?: string): Promise<BazaarResponse<T>> {
    const raw = body === undefined || method === 'GET' ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key) {
      const ts = Date.now();
      const nonce = randomBytes(12).toString('hex');
      Object.assign(headers, { 'x-key': key.pub, 'x-ts': String(ts), 'x-nonce': nonce, 'x-sig': key.sign([method, path, ts, nonce, sha256hex(raw)].join('\n')) });
      if (mandateId) headers['x-mandate'] = mandateId;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, { method, headers, body: raw || undefined, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw Object.assign(new Error('BAZAAR_UNREACHABLE'), { cause: e });
    }
    let json: any = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json as T };
  }

  async marketKey(): Promise<{ publicKey: string; payments: string | null }> {
    const r = await this.call(null, 'GET', '/.well-known/market-keys');
    if (r.status !== 200 || !r.body?.keys?.[0]?.public_key) throw new Error('BAZAAR_UNREACHABLE');
    this.marketPub = r.body.keys[0].public_key;
    return { publicKey: this.marketPub!, payments: r.body.payments ?? null };
  }

  async cachedMarketPub(): Promise<string> {
    return this.marketPub ?? (await this.marketKey()).publicKey;
  }
}
