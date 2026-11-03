import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Identity providers for PayPali's `kyc` assurance. PayPal is the provider.
//
//   paypal   Log in with PayPal (OAuth 2.0 / OpenID Connect). The owner signs in
//            to PayPal and consents to the `paypalattributes` scope, which
//            returns `verified_account` (PayPal has completed its own customer
//            verification for that account) and `payer_id` (the stable PayPal
//            account id). A verified account yields `kyc` assurance; the
//            payer id is the dedup key, so one PayPal account can back only
//            one PayPali owner.
//   sandbox  dev/test only: a PayPali-hosted page plays PayPal. Refused when
//            NODE_ENV=production.
//
// Providers hand back identifiers only. KycService turns them into keyed HMAC
// fingerprints immediately and never stores the raw values.
// ---------------------------------------------------------------------------

export type ProviderStatus = 'PENDING' | 'PROCESSING' | 'VERIFIED' | 'REQUIRES_INPUT' | 'CANCELED';

/** What a successful check yields. Transient: never persisted. */
export interface VerifiedIdentity {
  identifiers: Array<{ kind: string; value: string }>;   // e.g. {kind:'paypal_payer_id', value:'ABCD1234'}
}

export interface ProviderSession { providerSessionId: string; status: ProviderStatus; url?: string | null }

export interface ProviderResult { status: ProviderStatus; identity?: VerifiedIdentity; lastError?: string | null }

export interface KycProvider {
  readonly id: 'paypal' | 'sandbox';
  readonly method: 'paypal_verified_account' | 'sandbox';
  /** Start a check. `providerSessionId` doubles as the OAuth `state`: unguessable and single-use. */
  createSession(p: { sessionRef: string }): Promise<ProviderSession>;
  /** URL to (re)open an unfinished check. */
  resume(providerSessionId: string): Promise<ProviderSession>;
  /** Finish a check from the provider's callback parameters (PayPal: ?code=…&state=… or ?error=…). */
  complete(providerSessionId: string, params: Record<string, string | undefined>): Promise<ProviderResult>;
}

// ---------------------------------------------------------------------------
// PayPal: Log in with PayPal
// ---------------------------------------------------------------------------
export interface PayPalIdentityConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;                       // must be registered on the PayPal app (Log in with PayPal settings)
  env?: 'sandbox' | 'live';
  fetch?: typeof fetch;
}

export const PAYPAL_SCOPES = ['openid', 'https://uri.paypal.com/services/paypalattributes'];
const PAYPAL = {
  sandbox: { web: 'https://www.sandbox.paypal.com', api: 'https://api-m.sandbox.paypal.com' },
  live: { web: 'https://www.paypal.com', api: 'https://api-m.paypal.com' },
};

export class PayPalIdentityProvider implements KycProvider {
  readonly id = 'paypal' as const;
  readonly method = 'paypal_verified_account' as const;
  private readonly f: typeof fetch;
  private readonly urls: { web: string; api: string };
  constructor(private readonly cfg: PayPalIdentityConfig) {
    if (!cfg.clientId || !cfg.clientSecret || !cfg.redirectUri) throw new Error('PAYPAL_IDENTITY_CONFIG_INCOMPLETE');
    this.f = cfg.fetch ?? fetch;
    this.urls = PAYPAL[cfg.env ?? 'sandbox'];
  }

  authorizeUrl(state: string) {
    const q = new URLSearchParams({
      flowEntry: 'static', client_id: this.cfg.clientId, response_type: 'code', scope: PAYPAL_SCOPES.join(' '),
      redirect_uri: this.cfg.redirectUri, state,
    });
    return `${this.urls.web}/signin/authorize?${q}`;
  }

  async createSession(): Promise<ProviderSession> {
    const state = 'ppl_' + randomBytes(20).toString('hex');
    return { providerSessionId: state, status: 'PENDING', url: this.authorizeUrl(state) };
  }

  async resume(state: string): Promise<ProviderSession> {
    return { providerSessionId: state, status: 'PENDING', url: this.authorizeUrl(state) };
  }

  async complete(_state: string, params: Record<string, string | undefined>): Promise<ProviderResult> {
    if (params.error) return { status: params.error === 'access_denied' ? 'CANCELED' : 'REQUIRES_INPUT', lastError: `paypal_${String(params.error).slice(0, 60)}` };
    if (!params.code) return { status: 'REQUIRES_INPUT', lastError: 'paypal_missing_code' };

    // 1. Authorization code -> access token (server-side, client secret never leaves PayPali).
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const tr = await this.f(`${this.urls.api}/v1/oauth2/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: params.code }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const tok: any = await tr.json().catch(() => null);
    if (tr.status !== 200 || !tok?.access_token) return { status: 'REQUIRES_INPUT', lastError: `paypal_token_${tok?.error ?? tr.status}` };

    // 2. Userinfo with PayPal attributes. Some accounts/regions reject paypalv1.1; fall back to the OpenID endpoint.
    const auth = { authorization: `Bearer ${tok.access_token}`, accept: 'application/json' };
    let ur = await this.f(`${this.urls.api}/v1/identity/oauth2/userinfo?schema=paypalv1.1`, { headers: auth, signal: AbortSignal.timeout(15_000) });
    if (ur.status !== 200) ur = await this.f(`${this.urls.api}/v1/identity/openidconnect/userinfo?schema=openid`, { headers: auth, signal: AbortSignal.timeout(15_000) });
    const ui: any = await ur.json().catch(() => null);
    if (ur.status !== 200 || !ui) return { status: 'REQUIRES_INPUT', lastError: `paypal_userinfo_${ur.status}` };

    const verified = ui.verified_account === true || ui.verified_account === 'true';
    const payerId = typeof ui.payer_id === 'string' ? ui.payer_id.trim() : '';
    if (!payerId) return { status: 'REQUIRES_INPUT', lastError: 'paypal_payer_id_missing' };   // the app lacks the paypalattributes scope
    if (!verified) return { status: 'REQUIRES_INPUT', lastError: 'paypal_account_not_verified' };
    return { status: 'VERIFIED', identity: { identifiers: [{ kind: 'paypal_payer_id', value: payerId }] } };
  }
}

// ---------------------------------------------------------------------------
// Sandbox: PayPali hosts a page at /kyc/sandbox/:id that plays PayPal.
// ---------------------------------------------------------------------------
export class SandboxKycProvider implements KycProvider {
  readonly id = 'sandbox' as const;
  readonly method = 'sandbox' as const;
  private readonly open = new Set<string>();
  constructor(readonly publicUrl: string, env: NodeJS.ProcessEnv = process.env) {
    if (env.NODE_ENV === 'production') throw new Error('KYC_SANDBOX_NOT_ALLOWED_IN_PRODUCTION');
  }
  urlFor(id: string) { return `${this.publicUrl.replace(/\/+$/, '')}/kyc/sandbox/${id}`; }
  has(id: string) { return this.open.has(id); }
  async createSession() {
    const id = 'ksb_' + randomBytes(10).toString('hex');
    this.open.add(id);
    return { providerSessionId: id, status: 'PENDING' as const, url: this.urlFor(id) };
  }
  async resume(id: string): Promise<ProviderSession> {
    if (!this.open.has(id)) throw new Error('KYC_SESSION_NOT_FOUND');
    return { providerSessionId: id, status: 'PENDING', url: this.urlFor(id) };
  }
  /** params: {outcome: 'approve'|'decline'|'unverified', payerId} — the same shapes PayPal produces. */
  async complete(id: string, params: Record<string, string | undefined>): Promise<ProviderResult> {
    if (!this.open.has(id)) throw new Error('KYC_SESSION_NOT_FOUND');
    if (params.outcome === 'decline') return { status: 'CANCELED', lastError: 'paypal_access_denied' };
    if (params.outcome === 'unverified') return { status: 'REQUIRES_INPUT', lastError: 'paypal_account_not_verified' };
    const payerId = String(params.payerId ?? '').trim();
    if (!payerId) return { status: 'REQUIRES_INPUT', lastError: 'paypal_payer_id_missing' };
    return { status: 'VERIFIED', identity: { identifiers: [{ kind: 'paypal_payer_id', value: payerId }] } };
  }
}

export function kycProviderFromEnv(publicUrl: string, env: NodeJS.ProcessEnv = process.env): KycProvider | null {
  const which = env.PAYPALI_KYC_PROVIDER;
  if (!which) return null;
  if (which === 'sandbox') return new SandboxKycProvider(publicUrl, env);
  if (which === 'paypal') return new PayPalIdentityProvider({
    clientId: env.PAYPAL_CLIENT_ID ?? '', clientSecret: env.PAYPAL_CLIENT_SECRET ?? '',
    redirectUri: env.PAYPAL_IDENTITY_REDIRECT_URI ?? `${publicUrl.replace(/\/+$/, '')}/api/kyc/paypal/callback`,
    env: env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox',
  });
  throw new Error('UNKNOWN_KYC_PROVIDER:' + which);
}
