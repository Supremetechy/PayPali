// Low-level port the funding gateway depends on: capture an approved PayPal
// Order (the owner's authorization to fund the seed from their PayPal balance).
// Defined without any SDK import so PayPalFundingGateway — and its tests — need
// nothing from the network. PayPalServerSdkOrdersClient is the concrete adapter.

export interface CaptureOrderCommand {
  /** The approved PayPal Order id (carried as the seed's fundingSourceReference). */
  orderId: string;
  /** Idempotency key, sent as PayPal-Request-Id so a retry captures at most once. */
  requestId: string;
}

export type OrderCaptureOutcome =
  // Captured: funds moved from the owner's PayPal balance to the platform.
  | { status: 'COMPLETED'; captureId: string; amountMinor: bigint; currency: string }
  // The payer could not pay (declined instrument / insufficient balance). Terminal.
  | { status: 'DECLINED'; reason: string }
  // Anything else (auth, 5xx, malformed) — treated as retryable by the worker.
  | { status: 'ERROR'; reason: string };

export interface PayPalOrdersCapturePort {
  captureOrder(command: CaptureOrderCommand): Promise<OrderCaptureOutcome>;
}

/**
 * Parse a PayPal decimal amount string (e.g. "100.00") into integer minor units.
 * PayPali's supported currencies (USD/EUR/GBP/CAD) all use 2 decimal places.
 * Throws on anything it can't represent exactly, so a malformed amount can never
 * be silently mis-credited.
 */
export function payPalAmountToMinor(value: string, currencyCode: string): bigint {
  if (!/^\d+(\.\d{1,2})?$/.test(value ?? '')) {
    throw new Error(`UNPARSEABLE_PAYPAL_AMOUNT:${value}`);
  }
  if (!/^[A-Z]{3}$/.test(currencyCode ?? '')) {
    throw new Error(`UNSUPPORTED_CURRENCY:${currencyCode}`);
  }
  const [whole, frac = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'));
}
