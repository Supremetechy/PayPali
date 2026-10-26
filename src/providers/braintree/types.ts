export interface BraintreeConfig {
  merchantId: string;
  publicKey: string;
  privateKey: string;
  environment: 'sandbox' | 'production';
  timeoutMs?: number;
}

export type ProviderChargeResult =
  | {
      status: 'SUCCESS';
      transactionId: string;
      providerStatus: string;
      amountSettledMinor: bigint;
      currency: string;
      rawResponse: unknown;
    }
  | {
      status: 'DECLINED';
      reason: string;
      processorResponseCode?: string;
      rawResponse: unknown;
    }
  | {
      status: 'AMBIGUOUS';
      reason: string;
      error: Error;
      requiresReconciliation: true;
    };

export interface ChargeParams {
  intentId: string;
  idempotencyKey: string;
  paymentMethodId: string; // Nonce or vaulted token
  amountMinor: bigint;
  currency: string;
  merchantAccountId?: string;
}