import {
  IPayPalFundingGateway,
  SeedFundingRequest,
  SeedFundingResult,
} from './IPayPalFundingGateway';
import { PayPalOrdersCapturePort } from './PayPalOrdersPort';

// Real seed-funding gateway. Captures the owner-approved PayPal Order that backs
// the seed and maps the outcome onto the funding result SeedFundingWorker
// expects. SDK specifics live behind PayPalOrdersCapturePort, so this mapping —
// including the amount-integrity guard — is exercised without any network.
//
// Wiring (production):
//   const orders = new PayPalServerSdkOrdersClient({ clientId, clientSecret, environment });
//   const gateway = new PayPalFundingGateway(orders);
//   const worker = new SeedFundingWorker(prisma, gateway);
export class PayPalFundingGateway implements IPayPalFundingGateway {
  constructor(private readonly orders: PayPalOrdersCapturePort) {}

  async captureFromBalance(request: SeedFundingRequest): Promise<SeedFundingResult> {
    const outcome = await this.orders.captureOrder({
      orderId: request.fundingSourceReference,
      requestId: request.idempotencyKey,
    });

    if (outcome.status === 'DECLINED') {
      // The owner could not fund the seed — terminal, do not retry.
      return { status: 'INSUFFICIENT_FUNDS' };
    }
    if (outcome.status === 'ERROR') {
      return { status: 'FAILED', reason: outcome.reason };
    }

    // COMPLETED: never credit a seed for an amount or currency that disagrees
    // with what was authorized — mirror the payment settlement-integrity guard.
    if (
      outcome.amountMinor !== request.amountMinor ||
      outcome.currency.toUpperCase() !== request.currency.toUpperCase()
    ) {
      return { status: 'FAILED', reason: 'CAPTURE_AMOUNT_MISMATCH' };
    }

    return { status: 'CAPTURED', captureId: outcome.captureId };
  }
}
