import { describe, expect, it } from 'vitest';
import { PayPalFundingGateway } from '../src/providers/paypal/PayPalFundingGateway';
import {
  CaptureOrderCommand,
  OrderCaptureOutcome,
  PayPalOrdersCapturePort,
  payPalAmountToMinor,
} from '../src/providers/paypal/PayPalOrdersPort';

// A fake capture port — no SDK, no network. Records the command it was given.
class FakeOrdersPort implements PayPalOrdersCapturePort {
  readonly calls: CaptureOrderCommand[] = [];
  constructor(private readonly outcome: OrderCaptureOutcome | Error) {}
  async captureOrder(command: CaptureOrderCommand): Promise<OrderCaptureOutcome> {
    this.calls.push(command);
    if (this.outcome instanceof Error) {
      throw this.outcome;
    }
    return this.outcome;
  }
}

const request = {
  ownerId: 'owner_1',
  fundingSourceReference: 'ORDER7G21',
  amountMinor: 1_000_000n,
  currency: 'USD',
  idempotencyKey: 'seed-fund:seed_1',
};

describe('PayPalFundingGateway', () => {
  it('captures the approved order and returns CAPTURED on an exact match', async () => {
    const port = new FakeOrdersPort({
      status: 'COMPLETED',
      captureId: 'CAP123',
      amountMinor: 1_000_000n,
      currency: 'USD',
    });

    const result = await new PayPalFundingGateway(port).captureFromBalance(request);

    expect(result).toEqual({ status: 'CAPTURED', captureId: 'CAP123' });
    // Order id and idempotency key are forwarded to the capture.
    expect(port.calls[0]).toEqual({ orderId: 'ORDER7G21', requestId: 'seed-fund:seed_1' });
  });

  it('maps a declined payment to INSUFFICIENT_FUNDS (terminal)', async () => {
    const port = new FakeOrdersPort({ status: 'DECLINED', reason: 'INSTRUMENT_DECLINED' });
    const result = await new PayPalFundingGateway(port).captureFromBalance(request);
    expect(result).toEqual({ status: 'INSUFFICIENT_FUNDS' });
  });

  it('maps a transient error to FAILED (retryable)', async () => {
    const port = new FakeOrdersPort({ status: 'ERROR', reason: 'PAYPAL_503' });
    const result = await new PayPalFundingGateway(port).captureFromBalance(request);
    expect(result).toEqual({ status: 'FAILED', reason: 'PAYPAL_503' });
  });

  it('refuses to credit when the captured amount disagrees with the seed', async () => {
    const port = new FakeOrdersPort({
      status: 'COMPLETED',
      captureId: 'CAP999',
      amountMinor: 900_000n, // less than the authorized seed
      currency: 'USD',
    });
    const result = await new PayPalFundingGateway(port).captureFromBalance(request);
    expect(result).toEqual({ status: 'FAILED', reason: 'CAPTURE_AMOUNT_MISMATCH' });
  });

  it('refuses to credit when the captured currency disagrees', async () => {
    const port = new FakeOrdersPort({
      status: 'COMPLETED',
      captureId: 'CAP777',
      amountMinor: 1_000_000n,
      currency: 'EUR',
    });
    const result = await new PayPalFundingGateway(port).captureFromBalance(request);
    expect(result).toEqual({ status: 'FAILED', reason: 'CAPTURE_AMOUNT_MISMATCH' });
  });

  it('propagates an unexpected throw so the worker can retry', async () => {
    const port = new FakeOrdersPort(new Error('socket hang up'));
    await expect(
      new PayPalFundingGateway(port).captureFromBalance(request)
    ).rejects.toThrow('socket hang up');
  });
});

describe('payPalAmountToMinor', () => {
  it('parses PayPal decimal strings into exact minor units', () => {
    expect(payPalAmountToMinor('100.00', 'USD')).toBe(10_000n);
    expect(payPalAmountToMinor('10000', 'USD')).toBe(1_000_000n);
    expect(payPalAmountToMinor('0.05', 'USD')).toBe(5n);
    expect(payPalAmountToMinor('1234.5', 'GBP')).toBe(123_450n);
  });

  it('throws on a malformed amount or currency rather than mis-crediting', () => {
    expect(() => payPalAmountToMinor('1.005', 'USD')).toThrow('UNPARSEABLE_PAYPAL_AMOUNT');
    expect(() => payPalAmountToMinor('100.00', 'usd')).toThrow('UNSUPPORTED_CURRENCY');
  });
});
