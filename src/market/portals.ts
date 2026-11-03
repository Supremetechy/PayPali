import { randomUUID } from 'node:crypto';
import { PortalStatus } from './catalog';

// ---------------------------------------------------------------------------
// Service Agent Portal adapters — the seam where a real provider integration
// plugs in. A live adapter calls the provider's agent portal (its API for
// agent accounts) after PayPali has moved the Gas into escrow, and reports the
// result. Until a provider ships one, its portal is a placeholder.
// ---------------------------------------------------------------------------

export interface PortalOrder {
  orderId: string;
  serviceId: string;
  actionId: string;
  params: Record<string, unknown>;
  amountMinor: bigint;
  currency: string;
  agentId: string;
}

export type FulfilmentResult =
  | { status: 'FULFILLED'; providerRef: string; details?: Record<string, unknown> }
  | { status: 'PENDING'; providerRef?: string; details?: Record<string, unknown> }   // provider confirms later (webhook)
  | { status: 'FAILED'; reason: string };

export interface ServicePortal {
  readonly status: PortalStatus;
  /** Live integrations that need a platform credential opt in; it is passed out-of-band from the order. */
  readonly requiresSecret?: boolean;
  fulfil(order: PortalOrder, secret?: string): Promise<FulfilmentResult>;
}

/** No integration: GasService refuses to charge for these (PROVIDER_NOT_CONNECTED). */
export class PlaceholderPortal implements ServicePortal {
  readonly status = 'placeholder' as const;
  async fulfil(): Promise<FulfilmentResult> {
    return { status: 'FAILED', reason: 'PROVIDER_NOT_CONNECTED' };
  }
}

/**
 * DEV ONLY (PAYPALI_SERVICE_SANDBOX=1): pretends the provider accepted the order so the full
 * Gas flow — mandate, Score stake, escrow, settlement — can be exercised end to end. Every
 * result is marked sandbox:true. Never enable against real money.
 */
export class SandboxPortal implements ServicePortal {
  readonly status = 'sandbox' as const;
  async fulfil(order: PortalOrder): Promise<FulfilmentResult> {
    if (order.params && (order.params as Record<string, unknown>).sandbox_fail === true) {
      return { status: 'FAILED', reason: 'SANDBOX_PROVIDER_REJECTED' };
    }
    return { status: 'FULFILLED', providerRef: `sbx_${order.serviceId}_${randomUUID().slice(0, 8)}`, details: { sandbox: true } };
  }
}

export interface PortalRegistry {
  portalFor(serviceId: string): ServicePortal;
  secretFor?(serviceId: string): Promise<string | null>;
}

export function makePortalRegistry(opts: {
  sandbox?: boolean;
  live?: Record<string, ServicePortal>;
  secretFor?: (serviceId: string) => Promise<string | null>;
} = {}): PortalRegistry {
  const placeholder = new PlaceholderPortal();
  const sandbox = new SandboxPortal();
  return {
    secretFor: opts.secretFor,
    portalFor(serviceId: string) {
      return opts.live?.[serviceId] ?? (opts.sandbox ? sandbox : placeholder);
    },
  };
}
