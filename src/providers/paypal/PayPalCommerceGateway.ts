import {
  CommerceInboundRequest,
  CommercePayoutRequest,
  CommerceResult,
  CommerceSpendRequest,
  IPayPalCommerceGateway,
} from './IPayPalCommerceGateway';
import {
  OrderPaymentPort,
  PayoutPort,
  ProviderOutcome,
} from './PayPalCommercePorts';
import { PayPalOrdersCapturePort } from './PayPalOrdersPort';

// Live commerce gateway backed by PayPal. All decision/mapping logic lives here;
// the network lives behind the three injected ports (Orders create+capture for
// spend, Payouts for send, Order capture for inbound), so this maps outcomes to
// the CommerceResult contract and is fully exercised without any network.
//
// Mapping discipline (mirrors PayPalFundingGateway):
//   COMPLETED   -> PAID, but only when amount + currency match what was asked
//                  (settlement-integrity guard); a mismatch is AMBIGUOUS, never PAID.
//   DECLINED    -> DECLINED (terminal)
//   UNSUPPORTED -> UNSUPPORTED (terminal, surfaced verbatim)
//   ERROR       -> AMBIGUOUS (reconcile; the idempotency key keeps a retry safe)
export class PayPalCommerceGateway implements IPayPalCommerceGateway {
  constructor(
    private readonly orders: OrderPaymentPort,
    private readonly payouts: PayoutPort,
    private readonly capture: PayPalOrdersCapturePort
  ) {}

  async spend(request: CommerceSpendRequest): Promise<CommerceResult> {
    const outcome = await this.orders.createAndCaptureOrder({
      amountMinor: request.amountMinor,
      currency: request.currency,
      payeeReference: request.payeeReference,
      description: request.description,
      requestId: request.idempotencyKey,
    });
    return this.mapOutcome(outcome, request.amountMinor, request.currency);
  }

  async payout(request: CommercePayoutRequest): Promise<CommerceResult> {
    const outcome = await this.payouts.sendPayout({
      amountMinor: request.amountMinor,
      currency: request.currency,
      receiver: request.receiver,
      note: request.note,
      requestId: request.idempotencyKey,
    });
    return this.mapOutcome(outcome, request.amountMinor, request.currency);
  }

  async captureInbound(request: CommerceInboundRequest): Promise<CommerceResult> {
    const outcome = await this.capture.captureOrder({
      orderId: request.orderId,
      requestId: request.idempotencyKey,
    });
    if (outcome.status === 'COMPLETED') {
      return this.settledOrAmbiguous(
        outcome.captureId,
        outcome.amountMinor,
        outcome.currency,
        request.amountMinor,
        request.currency
      );
    }
    if (outcome.status === 'DECLINED') {
      return { status: 'DECLINED', reason: outcome.reason };
    }
    return { status: 'AMBIGUOUS', reason: outcome.reason };
  }

  private mapOutcome(
    outcome: ProviderOutcome,
    expectedMinor: bigint,
    expectedCurrency: string
  ): CommerceResult {
    switch (outcome.status) {
      case 'COMPLETED':
        return this.settledOrAmbiguous(
          outcome.providerRef,
          outcome.amountMinor,
          outcome.currency,
          expectedMinor,
          expectedCurrency
        );
      case 'DECLINED':
        return { status: 'DECLINED', reason: outcome.reason };
      case 'UNSUPPORTED':
        return { status: 'UNSUPPORTED', reason: outcome.reason };
      default:
        return { status: 'AMBIGUOUS', reason: outcome.reason };
    }
  }

  /** Never settle for an amount/currency that disagrees with what was authorized. */
  private settledOrAmbiguous(
    providerRef: string,
    gotMinor: bigint,
    gotCurrency: string,
    wantMinor: bigint,
    wantCurrency: string
  ): CommerceResult {
    if (gotMinor !== wantMinor || gotCurrency.toUpperCase() !== wantCurrency.toUpperCase()) {
      return { status: 'AMBIGUOUS', reason: 'PROVIDER_AMOUNT_MISMATCH' };
    }
    return { status: 'PAID', providerRef, amountMinor: gotMinor, currency: gotCurrency.toUpperCase() };
  }
}
