import { ApiError, Client, Environment, OrdersController } from '@paypal/paypal-server-sdk';
import {
  CreateCaptureOrderCommand,
  OrderPaymentPort,
  PayoutCommand,
  PayoutPort,
  ProviderOutcome,
} from './PayPalCommercePorts';
import { PayPalCommerceGateway } from './PayPalCommerceGateway';
import { PayPalServerSdkOrdersClient } from './PayPalServerSdkOrdersClient';
import { payPalAmountToMinor } from './PayPalOrdersPort';
import { IPayPalCommerceGateway } from './IPayPalCommerceGateway';

// Sandbox/production adapters that make the live commerce gateway real. These are
// the only files here that touch the PayPal network. Decision/mapping logic lives
// in PayPalCommerceGateway; these just talk to PayPal and classify the response.
//
// Credentials come from config (wire from a secret manager / env), never from
// agent input, and are never logged.

export interface PayPalCommerceConfig {
  clientId: string;
  clientSecret: string;
  environment: 'sandbox' | 'production';
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** minor units (e.g. 500) -> PayPal decimal string ("5.00") for 2-decimal currencies. */
function minorToDecimal(amountMinor: bigint): string {
  const neg = amountMinor < 0n;
  const abs = neg ? -amountMinor : amountMinor;
  const whole = abs / 100n;
  const cents = abs % 100n;
  return `${neg ? '-' : ''}${whole}.${cents.toString().padStart(2, '0')}`;
}

function restBase(environment: 'sandbox' | 'production'): string {
  return environment === 'production' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

/** Spend adapter: create a CAPTURE-intent Order to the payee and capture it. */
export class PayPalSdkOrderPaymentPort implements OrderPaymentPort {
  private readonly orders: OrdersController;

  constructor(config: PayPalCommerceConfig) {
    const client = new Client({
      clientCredentialsAuthCredentials: {
        oAuthClientId: config.clientId,
        oAuthClientSecret: config.clientSecret,
      },
      environment: config.environment === 'production' ? Environment.Production : Environment.Sandbox,
    });
    this.orders = new OrdersController(client);
  }

  async createAndCaptureOrder(command: CreateCaptureOrderCommand): Promise<ProviderOutcome> {
    try {
      const purchaseUnit: Record<string, unknown> = {
        amount: { currencyCode: command.currency, value: minorToDecimal(command.amountMinor) },
        description: command.description?.slice(0, 127),
      };
      // Route funds to the payee only when it's an email; otherwise pay to the
      // platform account (an opaque merchant id is not a valid payee here).
      if (EMAIL.test(command.payeeReference)) {
        purchaseUnit.payee = { emailAddress: command.payeeReference };
      }

      const created = await this.orders.createOrder({
        body: { intent: 'CAPTURE', purchaseUnits: [purchaseUnit] } as never,
        paypalRequestId: command.requestId,
        prefer: 'return=representation',
      });
      const orderId = created.result?.id;
      if (!orderId) {
        return { status: 'ERROR', reason: 'ORDER_CREATE_NO_ID' };
      }

      const captured = await this.orders.captureOrder({
        id: orderId,
        paypalRequestId: `${command.requestId}:capture`,
        prefer: 'return=representation',
      });
      const order = captured.result;
      if (order.status !== 'COMPLETED') {
        return { status: 'ERROR', reason: `ORDER_STATUS_${order.status ?? 'UNKNOWN'}` };
      }
      const capture = order.purchaseUnits?.[0]?.payments?.captures?.[0];
      if (!capture?.id || !capture.amount?.value || !capture.amount.currencyCode) {
        return { status: 'ERROR', reason: 'CAPTURE_DETAILS_MISSING' };
      }
      return {
        status: 'COMPLETED',
        providerRef: capture.id,
        amountMinor: payPalAmountToMinor(capture.amount.value, capture.amount.currencyCode),
        currency: capture.amount.currencyCode,
      };
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 422) {
        return { status: 'DECLINED', reason: 'INSTRUMENT_DECLINED' };
      }
      return { status: 'ERROR', reason: error instanceof ApiError ? `PAYPAL_${error.statusCode}` : 'PAYPAL_EXCEPTION' };
    }
  }
}

/** Send adapter: a single Payouts batch (the Payouts API is REST-only, not in the SDK). */
export class PayPalRestPayoutPort implements PayoutPort {
  constructor(private readonly config: PayPalCommerceConfig) {}

  private async accessToken(): Promise<string> {
    const auth = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    const res = await fetch(`${restBase(this.config.environment)}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`OAUTH_${res.status}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }

  async sendPayout(command: PayoutCommand): Promise<ProviderOutcome> {
    try {
      const token = await this.accessToken();
      const res = await fetch(`${restBase(this.config.environment)}/v1/payments/payouts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'PayPal-Request-Id': command.requestId, // idempotency
        },
        body: JSON.stringify({
          sender_batch_header: { sender_batch_id: command.requestId, email_subject: 'PayPali payout' },
          items: [
            {
              recipient_type: EMAIL.test(command.receiver) ? 'EMAIL' : 'PAYPAL_ID',
              amount: { value: minorToDecimal(command.amountMinor), currency: command.currency },
              receiver: command.receiver,
              note: command.note?.slice(0, 1000),
              sender_item_id: command.requestId,
            },
          ],
        }),
      });
      if (res.status === 201 || res.status === 200) {
        const body = (await res.json()) as { batch_header?: { payout_batch_id?: string } };
        const ref = body.batch_header?.payout_batch_id;
        if (!ref) return { status: 'ERROR', reason: 'PAYOUT_NO_BATCH_ID' };
        // Payouts settle asynchronously; the accepted batch is our provider ref.
        return { status: 'COMPLETED', providerRef: ref, amountMinor: command.amountMinor, currency: command.currency };
      }
      if (res.status === 422 || res.status === 400) {
        return { status: 'DECLINED', reason: `PAYOUT_${res.status}` };
      }
      return { status: 'ERROR', reason: `PAYOUT_${res.status}` };
    } catch (error) {
      return { status: 'ERROR', reason: error instanceof Error ? error.message : 'PAYOUT_EXCEPTION' };
    }
  }
}

/**
 * Spend adapter for the pooled-funds model. Owners' money sits in PayPali's PayPal business account and the
 * ledger tracks each agent's share, so an agent paying a payee is the platform sending money out: a Payout
 * to the payee's PayPal email. (Creating an order and capturing it ourselves cannot work: an order needs the
 * PAYER's approval, and here the platform is the payer.) Payees without a PayPal email are UNSUPPORTED.
 */
export class PayoutBackedSpendPort implements OrderPaymentPort {
  constructor(private readonly payouts: PayoutPort) {}
  async createAndCaptureOrder(command: CreateCaptureOrderCommand): Promise<ProviderOutcome> {
    if (!EMAIL.test(command.payeeReference)) return { status: 'UNSUPPORTED', reason: 'PAYEE_NEEDS_PAYPAL_EMAIL' };
    return this.payouts.sendPayout({ amountMinor: command.amountMinor, currency: command.currency, receiver: command.payeeReference, note: command.description, requestId: command.requestId });
  }
}

/** Assemble a live, PayPal-backed commerce gateway from credentials. */
export function makePayPalCommerceGateway(config: PayPalCommerceConfig): IPayPalCommerceGateway {
  const payouts = new PayPalRestPayoutPort(config);
  return new PayPalCommerceGateway(
    new PayoutBackedSpendPort(payouts),
    payouts,
    new PayPalServerSdkOrdersClient(config) // inbound capture reuses the funding capture client
  );
}
