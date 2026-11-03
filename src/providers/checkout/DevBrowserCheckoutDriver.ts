import { randomUUID } from 'node:crypto';
import { CommerceResult } from '../paypal/IPayPalCommerceGateway';
import {
  BrowserCheckoutRequest,
  IBrowserCheckoutDriver,
} from './IBrowserCheckoutDriver';

// Local dev checkout driver: simulates a completed browser checkout for http(s)
// URLs so the "pay on a site" flow is demoable without real automation or a real
// PayPal session. Anything that is not a well-formed http(s) URL is UNSUPPORTED,
// and a non-positive amount is DECLINED, so fail-closed behavior stays visible.
// This is a stand-in for a real driver (e.g. GstackBrowseCheckoutDriver); never
// use it to represent a real payment.
export class DevBrowserCheckoutDriver implements IBrowserCheckoutDriver {
  async checkout(request: BrowserCheckoutRequest): Promise<CommerceResult> {
    if (typeof request.amountMinor !== 'bigint' || request.amountMinor <= 0n) {
      return { status: 'DECLINED', reason: 'DEV_NON_POSITIVE_AMOUNT' };
    }
    let url: URL;
    try {
      url = new URL(request.siteUrl);
    } catch {
      return { status: 'UNSUPPORTED', reason: 'INVALID_SITE_URL' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { status: 'UNSUPPORTED', reason: 'UNSUPPORTED_URL_SCHEME' };
    }
    return {
      status: 'PAID',
      providerRef: `dev_checkout_${randomUUID()}`,
      amountMinor: request.amountMinor,
      currency: request.currency.toUpperCase(),
    };
  }
}
