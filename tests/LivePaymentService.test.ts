import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AgentWalletService } from '../src/services/AgentWalletService';
import { LivePaymentService } from '../src/services/LivePaymentService';
import {
  CommerceInboundRequest,
  CommercePayoutRequest,
  CommerceResult,
  CommerceSpendRequest,
  IPayPalCommerceGateway,
} from '../src/providers/paypal/IPayPalCommerceGateway';
import {
  BrowserCheckoutRequest,
  IBrowserCheckoutDriver,
} from '../src/providers/checkout/IBrowserCheckoutDriver';
import { createTestDb, seedOwnerAgentPolicy, TestDb } from './harness';

// Programmable commerce gateway: returns a fixed result and counts calls so we
// can assert the external provider is NOT called when we fail closed first.
class FakeCommerce implements IPayPalCommerceGateway {
  spendCalls = 0;
  payoutCalls = 0;
  inboundCalls = 0;
  constructor(private result: CommerceResult) {}
  async spend(_r: CommerceSpendRequest): Promise<CommerceResult> {
    this.spendCalls++;
    return this.result;
  }
  async payout(_r: CommercePayoutRequest): Promise<CommerceResult> {
    this.payoutCalls++;
    return this.result;
  }
  async captureInbound(_r: CommerceInboundRequest): Promise<CommerceResult> {
    this.inboundCalls++;
    return this.result;
  }
}
class FakeCheckout implements IBrowserCheckoutDriver {
  calls = 0;
  constructor(private result: CommerceResult) {}
  async checkout(_r: BrowserCheckoutRequest): Promise<CommerceResult> {
    this.calls++;
    return this.result;
  }
}

const paid = (amountMinor: bigint, ref = 'cap_x'): CommerceResult => ({
  status: 'PAID',
  providerRef: ref,
  amountMinor,
  currency: 'USD',
});

let db: TestDb;
let prisma: PrismaClient;
let wallet: AgentWalletService;

beforeEach(async () => {
  db = await createTestDb();
  prisma = db.prisma;
  wallet = new AgentWalletService(prisma);
});
afterEach(async () => {
  await db.close();
});

async function fundedAgent() {
  return seedOwnerAgentPolicy(prisma, { recipientId: 'merchant_1', merchantCategoryCode: '5734' });
}
const key = () => `idem_${randomUUID()}`;

describe('LivePaymentService.pay', () => {
  it('pays a merchant and debits the wallet exactly once', async () => {
    const { agentId } = await fundedAgent();
    const before = await wallet.getBalance(agentId, 'USD');
    const commerce = new FakeCommerce(paid(5000n, 'cap_1'));
    const live = new LivePaymentService(prisma, wallet, commerce, new FakeCheckout(paid(1n)));

    const res = await live.pay({
      agentId, payeeReference: 'merchant_1', amountMinor: 5000n, currency: 'USD',
      description: 'widget', idempotencyKey: key(),
    });

    expect(res.status).toBe('PAID');
    expect(res.providerRef).toBe('cap_1');
    expect(await wallet.getBalance(agentId, 'USD')).toBe(before - 5000n);
  });

  it('is idempotent: same key pays once and debits once', async () => {
    const { agentId } = await fundedAgent();
    const before = await wallet.getBalance(agentId, 'USD');
    const commerce = new FakeCommerce(paid(5000n));
    const live = new LivePaymentService(prisma, wallet, commerce, new FakeCheckout(paid(1n)));
    const k = key();

    await live.pay({ agentId, payeeReference: 'm', amountMinor: 5000n, currency: 'USD', description: 'x', idempotencyKey: k });
    const second = await live.pay({ agentId, payeeReference: 'm', amountMinor: 5000n, currency: 'USD', description: 'x', idempotencyKey: k });

    expect(second.status).toBe('PAID');
    expect(await wallet.getBalance(agentId, 'USD')).toBe(before - 5000n); // debited once
  });

  it('fails closed on insufficient funds WITHOUT calling PayPal', async () => {
    const { agentId } = await fundedAgent();
    const balance = await wallet.getBalance(agentId, 'USD');
    const commerce = new FakeCommerce(paid(balance + 1n));
    const live = new LivePaymentService(prisma, wallet, commerce, new FakeCheckout(paid(1n)));

    const res = await live.pay({
      agentId, payeeReference: 'm', amountMinor: balance + 1n, currency: 'USD', description: 'x', idempotencyKey: key(),
    });

    expect(res).toMatchObject({ status: 'DECLINED', reason: 'INSUFFICIENT_FUNDS' });
    expect(commerce.spendCalls).toBe(0); // never paid externally
    expect(await wallet.getBalance(agentId, 'USD')).toBe(balance);
  });

  it('refuses to pay for an inactive agent (no external call, no debit)', async () => {
    const { agentId } = await fundedAgent();
    await prisma.agent.update({ where: { id: agentId }, data: { isActive: false } });
    const commerce = new FakeCommerce(paid(5000n));
    const live = new LivePaymentService(prisma, wallet, commerce, new FakeCheckout(paid(1n)));

    const res = await live.pay({ agentId, payeeReference: 'm', amountMinor: 5000n, currency: 'USD', description: 'x', idempotencyKey: key() });

    expect(res).toMatchObject({ status: 'DECLINED', reason: 'AGENT_INACTIVE' });
    expect(commerce.spendCalls).toBe(0);
  });

  it('passes a provider DECLINED through and leaves the balance intact', async () => {
    const { agentId } = await fundedAgent();
    const before = await wallet.getBalance(agentId, 'USD');
    const commerce = new FakeCommerce({ status: 'DECLINED', reason: 'INSTRUMENT_DECLINED' });
    const live = new LivePaymentService(prisma, wallet, commerce, new FakeCheckout(paid(1n)));

    const res = await live.pay({ agentId, payeeReference: 'm', amountMinor: 5000n, currency: 'USD', description: 'x', idempotencyKey: key() });

    expect(res.status).toBe('DECLINED');
    expect(await wallet.getBalance(agentId, 'USD')).toBe(before);
  });

  it('passes UNSUPPORTED through and does not debit', async () => {
    const { agentId } = await fundedAgent();
    const before = await wallet.getBalance(agentId, 'USD');
    const commerce = new FakeCommerce({ status: 'UNSUPPORTED', reason: 'NO_ORDER' });
    const live = new LivePaymentService(prisma, wallet, commerce, new FakeCheckout(paid(1n)));

    const res = await live.pay({ agentId, payeeReference: 'm', amountMinor: 5000n, currency: 'USD', description: 'x', idempotencyKey: key() });

    expect(res).toMatchObject({ status: 'UNSUPPORTED', reason: 'NO_ORDER' });
    expect(await wallet.getBalance(agentId, 'USD')).toBe(before);
  });
});

describe('LivePaymentService.checkoutOnSite', () => {
  it('debits on a verified PAID checkout', async () => {
    const { agentId } = await fundedAgent();
    const before = await wallet.getBalance(agentId, 'USD');
    const checkout = new FakeCheckout(paid(1500n, 'chk_1'));
    const live = new LivePaymentService(prisma, wallet, new FakeCommerce(paid(1n)), checkout);

    const res = await live.checkoutOnSite({ agentId, siteUrl: 'https://shop.example.com/cart', amountMinor: 1500n, currency: 'USD', idempotencyKey: key() });

    expect(res.status).toBe('PAID');
    expect(await wallet.getBalance(agentId, 'USD')).toBe(before - 1500n);
  });

  it('does NOT debit when the driver returns AMBIGUOUS (unconfirmed checkout)', async () => {
    const { agentId } = await fundedAgent();
    const before = await wallet.getBalance(agentId, 'USD');
    const checkout = new FakeCheckout({ status: 'AMBIGUOUS', reason: 'PAYPAL_CHECKOUT_REQUIRES_HUMAN_APPROVAL' });
    const live = new LivePaymentService(prisma, wallet, new FakeCommerce(paid(1n)), checkout);

    const res = await live.checkoutOnSite({ agentId, siteUrl: 'https://shop.example.com', amountMinor: 1500n, currency: 'USD', idempotencyKey: key() });

    expect(res.status).toBe('AMBIGUOUS');
    expect(await wallet.getBalance(agentId, 'USD')).toBe(before);
  });
});

describe('LivePaymentService.payoutExternal', () => {
  it('sends a payout and debits the wallet', async () => {
    const { agentId } = await fundedAgent();
    const before = await wallet.getBalance(agentId, 'USD');
    const commerce = new FakeCommerce(paid(2000n, 'po_1'));
    const live = new LivePaymentService(prisma, wallet, commerce, new FakeCheckout(paid(1n)));

    const res = await live.payoutExternal({ agentId, receiver: 'payee@example.com', amountMinor: 2000n, currency: 'USD', note: 'thanks', idempotencyKey: key() });

    expect(res).toMatchObject({ status: 'PAID', providerRef: 'po_1' });
    expect(await wallet.getBalance(agentId, 'USD')).toBe(before - 2000n);
  });
});

describe('LivePaymentService.receiveInbound', () => {
  it('captures an inbound order and credits the wallet', async () => {
    const { agentId } = await fundedAgent();
    const before = await wallet.getBalance(agentId, 'USD');
    const commerce = new FakeCommerce(paid(7000n, 'in_1'));
    const live = new LivePaymentService(prisma, wallet, commerce, new FakeCheckout(paid(1n)));

    const res = await live.receiveInbound({ agentId, orderId: 'order_1', amountMinor: 7000n, currency: 'USD', idempotencyKey: key() });

    expect(res).toMatchObject({ status: 'PAID', providerRef: 'in_1' });
    expect(await wallet.getBalance(agentId, 'USD')).toBe(before + 7000n);
  });
});
