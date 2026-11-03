import { describe, expect, it } from 'vitest';
import { PayPalCommerceGateway } from '../src/providers/paypal/PayPalCommerceGateway';
import {
  CreateCaptureOrderCommand,
  OrderPaymentPort,
  PayoutCommand,
  PayoutPort,
  ProviderOutcome,
} from '../src/providers/paypal/PayPalCommercePorts';
import {
  CaptureOrderCommand,
  OrderCaptureOutcome,
  PayPalOrdersCapturePort,
} from '../src/providers/paypal/PayPalOrdersPort';

// Programmable low-level ports — each returns a queued outcome and records calls.
class FakeOrderPort implements OrderPaymentPort {
  calls: CreateCaptureOrderCommand[] = [];
  constructor(private outcome: ProviderOutcome) {}
  async createAndCaptureOrder(c: CreateCaptureOrderCommand): Promise<ProviderOutcome> {
    this.calls.push(c);
    return this.outcome;
  }
}
class FakePayoutPort implements PayoutPort {
  calls: PayoutCommand[] = [];
  constructor(private outcome: ProviderOutcome) {}
  async sendPayout(c: PayoutCommand): Promise<ProviderOutcome> {
    this.calls.push(c);
    return this.outcome;
  }
}
class FakeCapturePort implements PayPalOrdersCapturePort {
  constructor(private outcome: OrderCaptureOutcome) {}
  async captureOrder(_c: CaptureOrderCommand): Promise<OrderCaptureOutcome> {
    return this.outcome;
  }
}

const UNUSED_CAPTURE = new FakeCapturePort({ status: 'ERROR', reason: 'unused' });

function gateway(order: OrderPaymentPort, payout?: PayoutPort, capture?: PayPalOrdersCapturePort) {
  return new PayPalCommerceGateway(
    order,
    payout ?? new FakePayoutPort({ status: 'ERROR', reason: 'unused' }),
    capture ?? UNUSED_CAPTURE
  );
}

const spendReq = {
  payeeReference: 'merchant_1',
  amountMinor: 5000n,
  currency: 'USD',
  description: 'widget',
  idempotencyKey: 'k1',
};

describe('PayPalCommerceGateway.spend', () => {
  it('maps a matching COMPLETED order to PAID with the capture id', async () => {
    const order = new FakeOrderPort({ status: 'COMPLETED', providerRef: 'cap_1', amountMinor: 5000n, currency: 'USD' });
    const res = await gateway(order).spend(spendReq);
    expect(res).toEqual({ status: 'PAID', providerRef: 'cap_1', amountMinor: 5000n, currency: 'USD' });
    expect(order.calls[0].requestId).toBe('k1'); // idempotency key forwarded
  });

  it('refuses to settle when the captured amount disagrees (integrity guard)', async () => {
    const order = new FakeOrderPort({ status: 'COMPLETED', providerRef: 'cap_1', amountMinor: 4999n, currency: 'USD' });
    const res = await gateway(order).spend(spendReq);
    expect(res.status).toBe('AMBIGUOUS');
  });

  it('passes a DECLINED order through as terminal DECLINED', async () => {
    const order = new FakeOrderPort({ status: 'DECLINED', reason: 'INSTRUMENT_DECLINED' });
    expect((await gateway(order).spend(spendReq)).status).toBe('DECLINED');
  });

  it('passes UNSUPPORTED through verbatim (never simulated)', async () => {
    const order = new FakeOrderPort({ status: 'UNSUPPORTED', reason: 'NO_ORDER' });
    const res = await gateway(order).spend(spendReq);
    expect(res).toMatchObject({ status: 'UNSUPPORTED', reason: 'NO_ORDER' });
  });

  it('maps a provider ERROR to AMBIGUOUS so the caller reconciles', async () => {
    const order = new FakeOrderPort({ status: 'ERROR', reason: 'TIMEOUT' });
    expect((await gateway(order).spend(spendReq)).status).toBe('AMBIGUOUS');
  });
});

describe('PayPalCommerceGateway.payout', () => {
  it('maps a matching COMPLETED payout to PAID', async () => {
    const payout = new FakePayoutPort({ status: 'COMPLETED', providerRef: 'po_1', amountMinor: 2500n, currency: 'USD' });
    const res = await gateway(new FakeOrderPort({ status: 'ERROR', reason: 'x' }), payout).payout({
      receiver: 'payee@example.com',
      amountMinor: 2500n,
      currency: 'USD',
      note: 'thanks',
      idempotencyKey: 'p1',
    });
    expect(res).toMatchObject({ status: 'PAID', providerRef: 'po_1' });
  });
});

describe('PayPalCommerceGateway.captureInbound', () => {
  it('maps a matching COMPLETED capture to PAID', async () => {
    const capture = new FakeCapturePort({ status: 'COMPLETED', captureId: 'in_1', amountMinor: 10000n, currency: 'USD' });
    const res = await gateway(new FakeOrderPort({ status: 'ERROR', reason: 'x' }), undefined, capture).captureInbound({
      orderId: 'order_1',
      amountMinor: 10000n,
      currency: 'USD',
      idempotencyKey: 'i1',
    });
    expect(res).toMatchObject({ status: 'PAID', providerRef: 'in_1' });
  });

  it('maps a capture ERROR to AMBIGUOUS', async () => {
    const capture = new FakeCapturePort({ status: 'ERROR', reason: 'TIMEOUT' });
    const res = await gateway(new FakeOrderPort({ status: 'ERROR', reason: 'x' }), undefined, capture).captureInbound({
      orderId: 'order_1',
      amountMinor: 10000n,
      currency: 'USD',
      idempotencyKey: 'i1',
    });
    expect(res.status).toBe('AMBIGUOUS');
  });
});
