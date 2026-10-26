import {
  LedgerService,
  PaymentIntentResult,
} from './LedgerService';

export interface RequestPaymentInput {
  idempotencyKey: string;
  recipientId: string;
  merchantCategoryCode: string;
  amountMinor: bigint;
  currency: string;
  paymentMethodRef: string;
}

export interface AuthenticatedAgentContext {
  agentId: string;
  ownerId: string;
}

export interface AuthenticatedOwnerContext {
  ownerId: string;
}

export class PaymentOrchestrator {
  constructor(private readonly ledger: LedgerService) {}

  requestPayment(
    input: RequestPaymentInput,
    authenticatedAgent: AuthenticatedAgentContext
  ): Promise<PaymentIntentResult> {
    return this.ledger.reserveAndQueuePayment({
      ...input,
      agentId: authenticatedAgent.agentId,
      ownerId: authenticatedAgent.ownerId,
    });
  }

  approvePayment(
    intentId: string,
    approvalId: string,
    authenticatedOwner: AuthenticatedOwnerContext
  ): Promise<PaymentIntentResult> {
    return this.ledger.approveAndQueuePayment(
      intentId,
      authenticatedOwner.ownerId,
      approvalId
    );
  }
}
