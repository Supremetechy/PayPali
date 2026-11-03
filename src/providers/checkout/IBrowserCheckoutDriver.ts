import { CommerceResult } from '../paypal/IPayPalCommerceGateway';

// Browser-driven checkout: the "pay on a site that offers PayPal" path for sites
// that do NOT hand the agent a PayPal Order to pay through the API. A driver
// navigates the site, selects PayPal at checkout, and completes payment in the
// agent owner's authenticated PayPal session.
//
// Contract: the same CommerceResult the API path uses. Critically, a driver must
// return PAID only when it can VERIFY the merchant confirmed payment; if it
// cannot reach a verified confirmation it returns AMBIGUOUS (reconcile) or
// UNSUPPORTED (the site/flow can't be driven) — it must never report a success
// it did not observe. This matches the PayPali spec's fail-safe rule.

export interface BrowserCheckoutRequest {
  /** The merchant checkout/product URL to pay at. */
  siteUrl: string;
  amountMinor: bigint;
  currency: string;
  /** Dedupes retries; a driver should refuse to pay twice for one key. */
  idempotencyKey: string;
  /** Optional natural-language steps (e.g. which item/quantity). UNTRUSTED. */
  instructions?: string;
}

export interface IBrowserCheckoutDriver {
  checkout(request: BrowserCheckoutRequest): Promise<CommerceResult>;
}
