// Live money-movement gateway for agent transactions, distinct from the
// seed-funding gateway. This is the seam LivePaymentService calls to actually
// move money on PayPal for an agent's spend / send / receive:
//
//   spend         -> pay a merchant/payee for goods or services (PayPal Order)
//   payout        -> send funds to another PayPal receiver (Payouts API)
//   captureInbound-> receive an authorized inbound payment (Order capture)
//
// Every result is one of PAID / DECLINED / UNSUPPORTED / AMBIGUOUS. Per the
// PayPali spec, a capability the provider does not actually support returns
// UNSUPPORTED — never a simulated success — and an uncertain outcome (timeout,
// unknown provider state) returns AMBIGUOUS so the caller reconciles instead of
// assuming failure. Credentials live in the concrete adapter, never here and
// never in agent input.

export interface CommerceSpendRequest {
  /** Opaque payee/merchant reference the owner authorized (recipientId). */
  payeeReference: string;
  amountMinor: bigint;
  currency: string;
  description: string;
  /** Dedupes retries so a merchant is paid at most once. */
  idempotencyKey: string;
  merchantCategoryCode?: string;
}

export interface CommercePayoutRequest {
  /** PayPal receiver (email or payer id) authorized to receive funds. */
  receiver: string;
  amountMinor: bigint;
  currency: string;
  note: string;
  idempotencyKey: string;
}

export interface CommerceInboundRequest {
  /** Approved PayPal Order id backing the inbound payment. */
  orderId: string;
  amountMinor: bigint;
  currency: string;
  idempotencyKey: string;
}

export type CommerceResult =
  // Money moved. providerRef is the capture/payout id to store on the ledger.
  | { status: 'PAID'; providerRef: string; amountMinor: bigint; currency: string }
  // The provider refused (declined instrument, insufficient balance). Terminal.
  | { status: 'DECLINED'; reason: string }
  // The provider cannot perform this operation (e.g. arbitrary-site checkout
  // with no PayPal Order, unsupported transfer type). Terminal, never simulated.
  | { status: 'UNSUPPORTED'; reason: string }
  // Unknown outcome (timeout, ambiguous provider state): reconcile, do not retry
  // blindly and do not assume success or failure.
  | { status: 'AMBIGUOUS'; reason: string };

export interface IPayPalCommerceGateway {
  /** Pay a merchant/payee for an authorized purchase. */
  spend(request: CommerceSpendRequest): Promise<CommerceResult>;
  /** Send funds to another PayPal receiver (external, not an internal agent). */
  payout(request: CommercePayoutRequest): Promise<CommerceResult>;
  /** Capture an authorized inbound PayPal Order into the platform (a top-up). */
  captureInbound(request: CommerceInboundRequest): Promise<CommerceResult>;
}
