// Low-level ports the live commerce gateway depends on, defined without SDK
// imports so PayPalCommerceGateway and its tests need nothing from the network.
// Concrete adapters (SDK for Orders, REST for Payouts) implement these.

export interface CreateCaptureOrderCommand {
  amountMinor: bigint;
  currency: string;
  /** Opaque payee/merchant the funds go to. */
  payeeReference: string;
  description: string;
  /** Sent as PayPal-Request-Id so a retry pays at most once. */
  requestId: string;
}

export interface PayoutCommand {
  amountMinor: bigint;
  currency: string;
  /** Receiver email / payer id. */
  receiver: string;
  note: string;
  requestId: string;
}

export type ProviderOutcome =
  | { status: 'COMPLETED'; providerRef: string; amountMinor: bigint; currency: string }
  | { status: 'DECLINED'; reason: string }
  | { status: 'UNSUPPORTED'; reason: string }
  | { status: 'ERROR'; reason: string };

/** Create a PayPal Order to a payee and capture it in one authorized step. */
export interface OrderPaymentPort {
  createAndCaptureOrder(command: CreateCaptureOrderCommand): Promise<ProviderOutcome>;
}

/** Send a single payout to a receiver via PayPal's Payouts API. */
export interface PayoutPort {
  sendPayout(command: PayoutCommand): Promise<ProviderOutcome>;
}
