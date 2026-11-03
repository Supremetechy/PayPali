import { randomUUID } from 'node:crypto';
import {
  CommerceInboundRequest,
  CommercePayoutRequest,
  CommerceResult,
  CommerceSpendRequest,
  IPayPalCommerceGateway,
} from './IPayPalCommerceGateway';

// Local dev commerce gateway: every spend / payout / inbound capture "succeeds"
// so the full live flow can be exercised without PayPal credentials. Stands in
// for PayPalCommerceGateway during manual testing. A dev-only amount guard still
// declines non-positive amounts so fail-closed behavior is observable. Never use
// this against real money — swap in PayPalCommerceGateway for sandbox/production.
export class DevPayPalCommerceGateway implements IPayPalCommerceGateway {
  async spend(request: CommerceSpendRequest): Promise<CommerceResult> {
    return this.settle(request.amountMinor, request.currency, 'dev_capture');
  }
  async payout(request: CommercePayoutRequest): Promise<CommerceResult> {
    return this.settle(request.amountMinor, request.currency, 'dev_payout');
  }
  async captureInbound(request: CommerceInboundRequest): Promise<CommerceResult> {
    return this.settle(request.amountMinor, request.currency, 'dev_inbound');
  }

  private settle(amountMinor: bigint, currency: string, prefix: string): CommerceResult {
    if (typeof amountMinor !== 'bigint' || amountMinor <= 0n) {
      return { status: 'DECLINED', reason: 'DEV_NON_POSITIVE_AMOUNT' };
    }
    return {
      status: 'PAID',
      providerRef: `${prefix}_${randomUUID()}`,
      amountMinor,
      currency: currency.toUpperCase(),
    };
  }
}
