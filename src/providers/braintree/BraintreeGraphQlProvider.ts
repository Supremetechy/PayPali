import {
  BraintreeConfig,
  ChargeParams,
  ProviderChargeResult,
} from './types';
import {
  CHARGE_PAYMENT_METHOD_MUTATION,
  SEARCH_TRANSACTION_BY_ORDER_ID_QUERY,
} from './queries';
import { IBraintreeGraphQLProvider } from './IBraintreeClient';

class DefinitiveProviderError extends Error {}

export class BraintreeGraphQLProvider implements IBraintreeGraphQLProvider {
  private readonly endpoint: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: BraintreeConfig) {
    if (!config.merchantId || !config.publicKey || !config.privateKey) {
      throw new Error('BRAINTREE_CONFIG_ERROR: Missing required credentials');
    }

    this.endpoint =
      config.environment === 'production'
        ? 'https://payments.braintree-api.com/graphql'
        : 'https://payments.sandbox.braintree-api.com/graphql';

    const credentials = Buffer.from(
      `${config.publicKey}:${config.privateKey}`
    ).toString('base64');
    this.authHeader = `Basic ${credentials}`;
    this.timeoutMs = config.timeoutMs ?? 10000; // 10s default timeout
  }

  /**
   * Dispatches a payment via Braintree GraphQL chargePaymentMethod mutation.
   * Never throws uncaught exceptions on network failure: categorizes as AMBIGUOUS instead.
   */
  async charge(params: ChargeParams): Promise<ProviderChargeResult> {
    if (params.amountMinor <= 0n) {
      return {
        status: 'DECLINED',
        reason: 'INVALID_AMOUNT',
        rawResponse: null,
      };
    }
    const formattedAmount = `${params.amountMinor / 100n}.${(params.amountMinor % 100n)
      .toString()
      .padStart(2, '0')}`;

    const variables = {
      input: {
        clientMutationId: params.idempotencyKey,
        paymentMethodId: params.paymentMethodId,
        transaction: {
          amount: formattedAmount,
          orderId: params.intentId, // Binds intentId to Braintree orderId for reconciliation
          ...(params.merchantAccountId
            ? { merchantAccountId: params.merchantAccountId }
            : {}),
        },
      },
    };

    try {
      const response = await this.executeGraphQL<{
        chargePaymentMethod: {
          clientMutationId: string;
          transaction: any;
        };
      }>(CHARGE_PAYMENT_METHOD_MUTATION, variables, params.idempotencyKey);

      return this.evaluateTransactionPayload(
        response.data?.chargePaymentMethod?.transaction,
        response
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown provider error';
      if (!(err instanceof DefinitiveProviderError)) {
        return {
          status: 'AMBIGUOUS',
          reason: `Provider outcome requires reconciliation: ${message}`,
          error: err instanceof Error ? err : new Error(message),
          requiresReconciliation: true,
        };
      }

      return {
        status: 'DECLINED',
        reason: `Provider rejected request: ${message}`,
        rawResponse: null,
      };
    }
  }

  /**
   * Reconciles an ambiguous payment state by searching for transactions matching the intentId.
   */
  async reconcile(intentId: string): Promise<ProviderChargeResult> {
    try {
      const variables = {
        input: {
          orderId: { is: intentId },
        },
      };

      const response = await this.executeGraphQL<{
        search: {
          transactions: {
            edges: Array<{ node: any }>;
          };
        };
      }>(SEARCH_TRANSACTION_BY_ORDER_ID_QUERY, variables);

      const edges = response.data?.search?.transactions?.edges ?? [];

      if (edges.length === 0) {
        // Provider has no record of the orderId; safe to consider not charged
        return {
          status: 'DECLINED',
          reason: 'TRANSACTION_NOT_FOUND_ON_PROVIDER',
          rawResponse: response,
        };
      }

      // Multiple transactions with the same orderId indicate an integrity anomaly
      if (edges.length > 1) {
        return {
          status: 'AMBIGUOUS',
          reason: 'MULTIPLE_TRANSACTIONS_FOUND_FOR_INTENT',
          error: new Error('Integrity anomaly: duplicate orderId returned'),
          requiresReconciliation: true,
        };
      }

      const transaction = edges[0].node;
      return this.evaluateTransactionPayload(transaction, response);
    } catch (err: any) {
      return {
        status: 'AMBIGUOUS',
        reason: `Reconciliation check failed: ${err.message}`,
        error: err,
        requiresReconciliation: true,
      };
    }
  }

  /**
   * Maps Braintree transaction status into domain statuses.
   */
  private evaluateTransactionPayload(
    transaction: any,
    rawResponse: unknown
  ): ProviderChargeResult {
    if (!transaction) {
      return {
        status: 'DECLINED',
        reason: 'PROVIDER_RETURNED_NO_TRANSACTION',
        rawResponse,
      };
    }

    const { status, id, amount } = transaction;

    switch (status) {
      case 'SUBMITTED_FOR_SETTLEMENT':
      case 'SETTLING':
      case 'SETTLED':
      case 'AUTHORIZED': {
        const parsedMinor = this.parseMinorUnits(amount.value);
        return {
          status: 'SUCCESS',
          transactionId: id,
          providerStatus: status,
          amountSettledMinor: parsedMinor,
          currency: amount.currencyCode,
          rawResponse,
        };
      }

      case 'PROCESSOR_DECLINED':
      case 'GATEWAY_REJECTED':
      case 'FAILED':
      case 'VOIDED': {
        const history = transaction.statusHistory || [];
        const declineInfo = history[history.length - 1] || {};
        return {
          status: 'DECLINED',
          reason:
            declineInfo.gatewayRejectionReason ||
            declineInfo.processorResponseText ||
            status,
          processorResponseCode: declineInfo.processorResponseCode,
          rawResponse,
        };
      }

      default:
        // Any intermediate status (e.g. AUTHORIZING) must not be reported as final success
        return {
          status: 'AMBIGUOUS',
          reason: `Unrecognized or non-final provider status: ${status}`,
          error: new Error(`Intermediate provider status: ${status}`),
          requiresReconciliation: true,
        };
    }
  }

  private parseMinorUnits(value: unknown): bigint {
    if (
      typeof value !== 'string' ||
      !/^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.test(value)
    ) {
      throw new Error('INVALID_PROVIDER_AMOUNT');
    }

    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  }

  /**
   * Internal HTTP execution with timeout, authentication, and idempotency headers.
   */
  private async executeGraphQL<T>(
    query: string,
    variables: Record<string, unknown>,
    idempotencyKey?: string
  ): Promise<{ data?: T; errors?: any[] }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Braintree-Version': '2019-01-01',
      Authorization: this.authHeader,
    };

    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      if (
        res.status >= 400 &&
        res.status < 500 &&
        res.status !== 408
      ) {
        throw new DefinitiveProviderError(`Provider HTTP ${res.status}`);
      }
      if (res.status >= 500) {
        throw new Error(`Provider HTTP ${res.status}`);
      }

      const body = (await res.json()) as { data?: T; errors?: any[] };

      if (body.errors && body.errors.length > 0) {
        const message = body.errors.map((e) => e.message).join('; ');
        throw new Error(`GraphQL Errors: ${message}`);
      }

      return body;
    } finally {
      clearTimeout(timeout);
    }
  }
}