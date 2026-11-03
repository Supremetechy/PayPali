import { randomBytes } from 'node:crypto';
import { payPalAmountToMinor } from '../providers/paypal/PayPalOrdersPort';

// ---------------------------------------------------------------------------
// Funding providers: how money gets from an owner's PayPal into PayPali.
//
//   PayPalFundingProvider  Orders v2 over REST (sandbox or production):
//                            create → owner approves (PayPal buttons or redirect) → capture
//                            optional "save PayPal" (vault) on the first approval, then
//                            merchant-initiated charges with the vault id (allowances)
//   DevFundingProvider     the same contract in memory, approved on a local page,
//                            for running without PayPal credentials. Never used when
//                            PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are set.
// ---------------------------------------------------------------------------

export interface CreateFundingOrder {
  amountMinor: bigint;
  currency: string;
  /** Our FundingOrder id: PayPal custom_id, so the order can always be traced back. */
  reference: string;
  description: string;
  /** Ask PayPal to save the payer's PayPal account (vault) for later allowance charges. */
  saveForAllowance: boolean;
  returnUrl: string;
  cancelUrl: string;
  requestId: string;
}

export type CaptureOutcome =
  | { status: 'COMPLETED'; captureId: string; amountMinor: bigint; currency: string; vault?: { id: string; customerId?: string } | null }
  | { status: 'NOT_APPROVED'; reason: string }      // the owner hasn't approved yet: try again later
  | { status: 'DECLINED'; reason: string }          // terminal
  | { status: 'ERROR'; reason: string };            // retryable

export interface FundingProvider {
  readonly id: string;                               // "paypal:sandbox" | "paypal:production" | "dev"
  /** Public client id for the PayPal JS SDK (null in dev). */
  readonly clientId: string | null;
  /** Whether this account may save PayPal accounts (vault): true / false once known, null until PayPal has answered. */
  readonly vaultAvailable?: boolean | null;
  /** `vaultSkipped` is set when the order was created WITHOUT saving PayPal although it was asked for. */
  createOrder(o: CreateFundingOrder): Promise<{ orderId: string; approveUrl: string; vaultSkipped?: string }>;
  captureOrder(orderId: string, requestId: string): Promise<CaptureOutcome>;
  /** Merchant-initiated charge of a saved PayPal account (no buyer present). */
  chargeSaved(o: { vaultId: string; amountMinor: bigint; currency: string; reference: string; description: string; requestId: string }): Promise<CaptureOutcome & { orderId?: string }>;
}

export const minorToDecimal = (m: bigint) => `${m / 100n}.${(m % 100n).toString().padStart(2, '0')}`;

// ---------------------------------------------------------------------------
// PayPal (REST, no SDK: the vault fields are plain JSON here)
// ---------------------------------------------------------------------------

export interface PayPalConfig { clientId: string; clientSecret: string; environment: 'sandbox' | 'production'; brandName?: string; vault?: boolean }

/** PayPal's answers when the REST app / merchant account is not approved to save payment methods. */
export const VAULT_NOT_ENABLED = /^(NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE|PAYEE_NOT_ENABLED_FOR_VAULT|VAULT_NOT_ENABLED|PERMISSION_DENIED)$/;

export class PayPalApiError extends Error {
  constructor(readonly status: number, readonly issue: string | null, readonly debugId: string | null) { super(`PAYPAL_${status}${issue ? ':' + issue : ''}`); }
}

export class PayPalRest {
  private token: { value: string; exp: number } | null = null;
  readonly base: string;
  constructor(readonly cfg: PayPalConfig, private readonly fetchFn: typeof fetch = fetch) {
    this.base = cfg.environment === 'production' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const res = await this.fetchFn(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new PayPalApiError(res.status, 'OAUTH_FAILED', res.headers.get('paypal-debug-id'));
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  async call<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchFn(this.base + path, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json', prefer: 'return=representation', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (!res.ok) throw new PayPalApiError(res.status, json?.details?.[0]?.issue ?? json?.name ?? null, res.headers.get('paypal-debug-id') ?? json?.debug_id ?? null);
    return json as T;
  }
}

/** Read a completed order (create or capture response) into a CaptureOutcome. */
export function outcomeFromOrder(order: any): CaptureOutcome {
  const cap = order?.purchase_units?.[0]?.payments?.captures?.[0];
  if (order?.status !== 'COMPLETED' || !cap) {
    if (order?.status === 'PAYER_ACTION_REQUIRED' || order?.status === 'CREATED') return { status: 'NOT_APPROVED', reason: `ORDER_${order.status}` };
    return { status: 'ERROR', reason: `ORDER_STATUS_${order?.status ?? 'UNKNOWN'}` };
  }
  if (cap.status === 'DECLINED' || cap.status === 'FAILED') return { status: 'DECLINED', reason: `CAPTURE_${cap.status}` };
  // PENDING captures (e.g. eCheck, review) are not spendable yet: treat as not completed.
  if (cap.status !== 'COMPLETED') return { status: 'ERROR', reason: `CAPTURE_${cap.status}` };
  const v = order?.payment_source?.paypal?.attributes?.vault;
  return {
    status: 'COMPLETED', captureId: cap.id, amountMinor: payPalAmountToMinor(cap.amount.value, cap.amount.currency_code), currency: cap.amount.currency_code,
    vault: v?.id && v?.status === 'VAULTED' ? { id: v.id, customerId: v.customer?.id } : null,
  };
}

export class PayPalFundingProvider implements FundingProvider {
  readonly id: string;
  readonly clientId: string;
  readonly rest: PayPalRest;
  constructor(cfg: PayPalConfig, fetchFn: typeof fetch = fetch) {
    this.rest = new PayPalRest(cfg, fetchFn);
    this.id = `paypal:${cfg.environment}`;
    this.clientId = cfg.clientId;
    this.vaultAvailable = cfg.vault === false ? false : null;
  }

  /** null until PayPal answers; false when the app/account isn't enabled to vault (or PAYPAL_VAULT=0). */
  vaultAvailable: boolean | null;

  /**
   * "Save this PayPal" needs the Vault feature on the REST app. Without it PayPal refuses the whole order
   * (422 NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE), so we create the same order without saving and say so:
   * the payment still goes through, and allowances fall back to "approve each period".
   */
  async createOrder(o: CreateFundingOrder): Promise<{ orderId: string; approveUrl: string; vaultSkipped?: string }> {
    const wantVault = o.saveForAllowance && this.vaultAvailable !== false;
    try {
      const r = await this.placeOrder(o, wantVault, o.requestId);
      if (wantVault) this.vaultAvailable = true;
      return o.saveForAllowance && !wantVault ? { ...r, vaultSkipped: 'PAYPAL_VAULT_NOT_ENABLED' } : r;
    } catch (e) {
      if (!(wantVault && e instanceof PayPalApiError && e.status === 422 && VAULT_NOT_ENABLED.test(e.issue ?? ''))) throw e;
      this.vaultAvailable = false;
      console.warn(`[funding] PayPal refused to save the payer's account (${e.issue}). Orders continue without it; enable "Save payment methods" on the PayPal app for allowances charged without asking.`);
      return { ...(await this.placeOrder(o, false, o.requestId + ':novault')), vaultSkipped: 'PAYPAL_VAULT_NOT_ENABLED' };
    }
  }

  private async placeOrder(o: CreateFundingOrder, vault: boolean, requestId: string) {
    const paypal: Record<string, unknown> = {
      experience_context: {
        brand_name: (this.rest.cfg.brandName ?? 'PayPali').slice(0, 127), user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING',
        return_url: o.returnUrl, cancel_url: o.cancelUrl,
      },
    };
    if (vault) paypal.attributes = { vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT', customer_type: 'CONSUMER', permit_multiple_payment_tokens: true } };
    const order = await this.rest.call('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: 'paypali', custom_id: o.reference, description: o.description.slice(0, 127), amount: { currency_code: o.currency, value: minorToDecimal(o.amountMinor) } }],
      payment_source: { paypal },
    }, { 'paypal-request-id': requestId });
    const approve = (order.links ?? []).find((l: any) => l.rel === 'payer-action' || l.rel === 'approve');
    if (!order.id || !approve) throw new Error('PAYPAL_ORDER_HAS_NO_APPROVAL_LINK');
    return { orderId: order.id as string, approveUrl: approve.href as string };
  }

  async captureOrder(orderId: string, requestId: string): Promise<CaptureOutcome> {
    try {
      return outcomeFromOrder(await this.rest.call('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, { 'paypal-request-id': requestId }));
    } catch (e) {
      if (e instanceof PayPalApiError) {
        if (e.issue === 'ORDER_NOT_APPROVED' || e.issue === 'PAYER_ACTION_REQUIRED') return { status: 'NOT_APPROVED', reason: e.issue };
        if (e.issue === 'ORDER_ALREADY_CAPTURED') {
          try { return outcomeFromOrder(await this.rest.call('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`)); } catch { /* fall through */ }
        }
        if (e.status === 422) return { status: 'DECLINED', reason: e.issue ?? 'UNPROCESSABLE' };
        return { status: 'ERROR', reason: e.message };
      }
      return { status: 'ERROR', reason: 'PAYPAL_UNREACHABLE' };
    }
  }

  async chargeSaved(o: { vaultId: string; amountMinor: bigint; currency: string; reference: string; description: string; requestId: string }) {
    try {
      const order = await this.rest.call('POST', '/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: 'paypali', custom_id: o.reference, description: o.description.slice(0, 127), amount: { currency_code: o.currency, value: minorToDecimal(o.amountMinor) } }],
        payment_source: { paypal: { vault_id: o.vaultId } },
      }, { 'paypal-request-id': o.requestId });
      // With a vault id and no buyer present, PayPal normally completes the order on creation.
      const done = order.status === 'COMPLETED' ? outcomeFromOrder(order) : await this.captureOrder(order.id, `${o.requestId}:capture`);
      return { ...done, orderId: order.id as string };
    } catch (e) {
      if (e instanceof PayPalApiError) return e.status === 422 ? { status: 'DECLINED' as const, reason: e.issue ?? 'UNPROCESSABLE' } : { status: 'ERROR' as const, reason: e.message };
      return { status: 'ERROR' as const, reason: 'PAYPAL_UNREACHABLE' };
    }
  }
}

// ---------------------------------------------------------------------------
// Dev provider: the same contract, approved on a local page (/fund/dev/:orderId).
// ---------------------------------------------------------------------------

interface DevOrder { amountMinor: bigint; currency: string; save: boolean; state: 'CREATED' | 'APPROVED' | 'CANCELLED' | 'CAPTURED'; returnUrl: string; cancelUrl: string; captureId?: string; vaultId?: string; description: string }

export class DevFundingProvider implements FundingProvider {
  readonly id = 'dev';
  readonly clientId = null;
  readonly orders = new Map<string, DevOrder>();
  readonly vaults = new Set<string>();
  /** Set to make the next saved-account charge decline (tests). */
  declineNextSavedCharge = false;
  constructor(private readonly publicUrl: string) {}

  async createOrder(o: CreateFundingOrder) {
    const orderId = 'DEV' + randomBytes(8).toString('hex').toUpperCase();
    this.orders.set(orderId, { amountMinor: o.amountMinor, currency: o.currency, save: o.saveForAllowance, state: 'CREATED', returnUrl: o.returnUrl, cancelUrl: o.cancelUrl, description: o.description });
    return { orderId, approveUrl: `${this.publicUrl}/fund/dev/${orderId}` };
  }

  /** What the dev approval page does. */
  decide(orderId: string, approve: boolean): string | null {
    const o = this.orders.get(orderId);
    if (!o || o.state !== 'CREATED') return null;
    o.state = approve ? 'APPROVED' : 'CANCELLED';
    const u = new URL(approve ? o.returnUrl : o.cancelUrl);
    u.searchParams.set('token', orderId);
    return u.toString();
  }

  async captureOrder(orderId: string): Promise<CaptureOutcome> {
    const o = this.orders.get(orderId);
    if (!o) return { status: 'ERROR', reason: 'ORDER_NOT_FOUND' };
    if (o.state === 'CREATED') return { status: 'NOT_APPROVED', reason: 'ORDER_NOT_APPROVED' };
    if (o.state === 'CANCELLED') return { status: 'DECLINED', reason: 'ORDER_CANCELLED' };
    if (o.state === 'APPROVED') {
      o.state = 'CAPTURED';
      o.captureId = 'DEVCAP' + randomBytes(6).toString('hex').toUpperCase();
      if (o.save) { o.vaultId = 'devvault_' + randomBytes(6).toString('hex'); this.vaults.add(o.vaultId); }
    }
    return { status: 'COMPLETED', captureId: o.captureId!, amountMinor: o.amountMinor, currency: o.currency, vault: o.vaultId ? { id: o.vaultId, customerId: 'devcust' } : null };
  }

  async chargeSaved(o: { vaultId: string; amountMinor: bigint; currency: string }) {
    if (!this.vaults.has(o.vaultId)) return { status: 'DECLINED' as const, reason: 'VAULT_TOKEN_UNKNOWN' };
    if (this.declineNextSavedCharge) { this.declineNextSavedCharge = false; return { status: 'DECLINED' as const, reason: 'INSTRUMENT_DECLINED' }; }
    const orderId = 'DEV' + randomBytes(8).toString('hex').toUpperCase();
    return { status: 'COMPLETED' as const, captureId: 'DEVCAP' + randomBytes(6).toString('hex').toUpperCase(), amountMinor: o.amountMinor, currency: o.currency, vault: null, orderId };
  }
}

export function fundingProviderFromEnv(publicUrl: string, env: NodeJS.ProcessEnv = process.env): FundingProvider {
  const id = env.PAYPAL_CLIENT_ID, secret = env.PAYPAL_CLIENT_SECRET;
  if (id && secret) return new PayPalFundingProvider({ clientId: id, clientSecret: secret, environment: env.PAYPAL_ENV === 'production' ? 'production' : 'sandbox', brandName: env.PAYPALI_BRAND_NAME, vault: env.PAYPAL_VAULT === '0' ? false : undefined });
  if (env.NODE_ENV === 'production') throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required in production');
  return new DevFundingProvider(publicUrl);
}
