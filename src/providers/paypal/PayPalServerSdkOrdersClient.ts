import {
  ApiError,
  Client,
  Environment,
  OrdersController,
} from '@paypal/paypal-server-sdk';
import {
  CaptureOrderCommand,
  OrderCaptureOutcome,
  PayPalOrdersCapturePort,
  payPalAmountToMinor,
} from './PayPalOrdersPort';

export interface PayPalFundingConfig {
  clientId: string;
  clientSecret: string;
  environment: 'sandbox' | 'production';
}

// Concrete capture port backed by PayPal's official server SDK
// (@paypal/paypal-server-sdk). This is the single file that touches the SDK and
// the network; all funding decision logic lives in PayPalFundingGateway. Capture
// is made idempotent by passing the worker's stable key as PayPal-Request-Id, so
// a retried capture of the same order is deduplicated by PayPal.
//
// Credentials come from config (wire them from a secret manager / env), never
// from agent input, and are never logged.
export class PayPalServerSdkOrdersClient implements PayPalOrdersCapturePort {
  private readonly orders: OrdersController;

  constructor(config: PayPalFundingConfig) {
    const client = new Client({
      clientCredentialsAuthCredentials: {
        oAuthClientId: config.clientId,
        oAuthClientSecret: config.clientSecret,
      },
      environment:
        config.environment === 'production'
          ? Environment.Production
          : Environment.Sandbox,
    });
    this.orders = new OrdersController(client);
  }

  async captureOrder(command: CaptureOrderCommand): Promise<OrderCaptureOutcome> {
    try {
      const response = await this.orders.captureOrder({
        id: command.orderId,
        paypalRequestId: command.requestId, // -> PayPal-Request-Id (idempotency)
        prefer: 'return=representation',
      });

      const order = response.result;
      if (order.status !== 'COMPLETED') {
        return { status: 'ERROR', reason: `ORDER_STATUS_${order.status ?? 'UNKNOWN'}` };
      }

      const capture = order.purchaseUnits?.[0]?.payments?.captures?.[0];
      if (!capture?.id || !capture.amount?.value || !capture.amount.currencyCode) {
        return { status: 'ERROR', reason: 'CAPTURE_DETAILS_MISSING' };
      }

      return {
        status: 'COMPLETED',
        captureId: capture.id,
        amountMinor: payPalAmountToMinor(capture.amount.value, capture.amount.currencyCode),
        currency: capture.amount.currencyCode,
      };
    } catch (error) {
      return this.mapError(error);
    }
  }

  private mapError(error: unknown): OrderCaptureOutcome {
    if (error instanceof ApiError) {
      // 422 UNPROCESSABLE_ENTITY is PayPal's declined-payment class
      // (INSTRUMENT_DECLINED, PAYER_CANNOT_PAY, insufficient balance): terminal.
      if (error.statusCode === 422) {
        return { status: 'DECLINED', reason: this.firstIssue(error) ?? 'INSTRUMENT_DECLINED' };
      }
      // Auth / rate-limit / server errors: retryable by the worker.
      return { status: 'ERROR', reason: `PAYPAL_${error.statusCode}` };
    }
    // Unknown (network/timeout): retryable — the idempotency key keeps it safe.
    return { status: 'ERROR', reason: 'PAYPAL_CAPTURE_EXCEPTION' };
  }

  private firstIssue(error: ApiError): string | undefined {
    const details = (error.result as { details?: Array<{ issue?: string }> } | undefined)?.details;
    return details?.[0]?.issue;
  }
}
