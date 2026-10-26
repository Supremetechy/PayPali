// src/providers/braintree/IBraintreeClient.ts
import { ChargeParams, ProviderChargeResult } from './types';

export interface IBraintreeGraphQLProvider {
  /**
   * Executes a transaction via Braintree's GraphQL chargePaymentMethod mutation.
   * Must pass a deterministic clientMutationId / idempotency key.
   */
  charge(params: ChargeParams): Promise<ProviderChargeResult>;

  /**
   * Query transaction status for reconciliation when network timeouts occur.
   */
  reconcile(intentId: string): Promise<ProviderChargeResult>;
}