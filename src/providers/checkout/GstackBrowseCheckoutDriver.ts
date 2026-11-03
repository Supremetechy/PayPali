import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CommerceResult } from '../paypal/IPayPalCommerceGateway';
import {
  BrowserCheckoutRequest,
  IBrowserCheckoutDriver,
} from './IBrowserCheckoutDriver';

const run = promisify(execFile);

// Real browser-driven checkout backed by the shared gstack `browse` Chromium
// (one browser per box — we do NOT bundle a second Playwright/Chromium). It
// navigates the merchant URL and detects whether PayPal is offered at checkout.
//
// It deliberately does NOT auto-complete a purchase: reliably driving an
// arbitrary third-party checkout to a VERIFIED confirmation — with the owner's
// real PayPal session and real money — cannot be done safely or idempotently
// here. So it returns:
//   UNSUPPORTED - the browse tool is unavailable, the URL is bad, or no PayPal
//                 option is detected on the page.
//   AMBIGUOUS   - PayPal is offered but completion needs human approval/handoff;
//                 the caller must confirm before treating funds as moved.
// It never returns PAID, because it never observes a confirmed payment. A future
// agentic-commerce-protocol driver can return PAID once the handshake confirms.
export class GstackBrowseCheckoutDriver implements IBrowserCheckoutDriver {
  private readonly browseBin: string | null;

  constructor(browseBin?: string) {
    this.browseBin = browseBin ?? GstackBrowseCheckoutDriver.resolveBrowseBin();
  }

  static resolveBrowseBin(): string | null {
    const candidates = [
      join(process.cwd(), '.claude/skills/gstack/browse/dist/browse'),
      join(homedir(), '.claude/skills/gstack/browse/dist/browse'),
    ];
    return candidates.find((p) => existsSync(p)) ?? null;
  }

  async checkout(request: BrowserCheckoutRequest): Promise<CommerceResult> {
    if (typeof request.amountMinor !== 'bigint' || request.amountMinor <= 0n) {
      return { status: 'DECLINED', reason: 'NON_POSITIVE_AMOUNT' };
    }
    if (!this.browseBin) {
      return { status: 'UNSUPPORTED', reason: 'BROWSE_TOOL_UNAVAILABLE' };
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

    try {
      await run(this.browseBin, ['goto', url.toString()], { timeout: 30_000 });
      const { stdout } = await run(
        this.browseBin,
        ['js', 'document.body.innerText.toLowerCase().includes("paypal")'],
        { timeout: 15_000 }
      );
      const offersPayPal = stdout.trim().includes('true');
      if (!offersPayPal) {
        return { status: 'UNSUPPORTED', reason: 'NO_PAYPAL_OPTION_DETECTED' };
      }
      // PayPal is offered, but we have not observed a confirmed payment.
      return { status: 'AMBIGUOUS', reason: 'PAYPAL_CHECKOUT_REQUIRES_HUMAN_APPROVAL' };
    } catch {
      return { status: 'AMBIGUOUS', reason: 'BROWSE_NAVIGATION_FAILED' };
    }
  }
}
