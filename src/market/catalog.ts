// ---------------------------------------------------------------------------
// Service marketplace catalog — the "extended marketplace" external agents shop.
//
// Every service here is a PLACEHOLDER: PayPali has no agreement or API
// integration with these companies yet, and the Gas figures are illustrative,
// not the providers' real prices. A placeholder portal can be quoted and
// browsed, but pay_with_gas refuses it with PROVIDER_NOT_CONNECTED before any
// money moves. When a provider ships an Agent Portal, its entry flips to
// `live` and gets a real ServicePortal adapter (see portals.ts).
// ---------------------------------------------------------------------------

export type PortalStatus = 'placeholder' | 'sandbox' | 'live';

export interface ParamSpec {
  type: 'integer' | 'string';
  description: string;
  minimum?: number;
  maximum?: number;
  required?: boolean;
}

export interface ServiceAction {
  id: string;
  name: string;
  description: string;
  /** fixed: a set Gas price. metered: Gas derived from money params (e.g. a fare estimate). */
  kind: 'fixed' | 'metered';
  gas?: number;
  /** For metered actions: params (in minor units) summed to the amount being paid. */
  meteredBy?: string[];
  params?: Record<string, ParamSpec>;
  /** Recurring charges need the agent's mandate to allow subscriptions explicitly (future). */
  recurring?: 'monthly';
}

export interface ServiceDef {
  id: string;
  name: string;
  category: 'streaming' | 'shopping' | 'rides' | 'food' | 'grocery' | 'music' | 'charging';
  description: string;
  portal: { status: PortalStatus; protocol: string; note: string };
  actions: ServiceAction[];
}

const PLACEHOLDER = (name: string) => ({
  status: 'placeholder' as const,
  protocol: 'paypali-agent-portal/0.1',
  note: `Placeholder. No ${name} Agent Portal is connected yet; prices are illustrative.`,
});

const money = (description: string, max = 5_000_000): ParamSpec => ({ type: 'integer', description, minimum: 1, maximum: max, required: true });

export const SERVICES: ServiceDef[] = [
  {
    id: 'netflix', name: 'Netflix', category: 'streaming', description: 'Streaming subscription managed by your agent.',
    portal: PLACEHOLDER('Netflix'),
    actions: [
      { id: 'subscribe_standard_ads', name: 'Standard with ads (monthly)', description: 'Start or renew the ad-supported plan.', kind: 'fixed', gas: 8_000, recurring: 'monthly' },
      { id: 'subscribe_standard', name: 'Standard (monthly)', description: 'Start or renew the standard plan.', kind: 'fixed', gas: 18_000, recurring: 'monthly' },
    ],
  },
  {
    id: 'hulu', name: 'Hulu', category: 'streaming', description: 'Streaming subscription managed by your agent.',
    portal: PLACEHOLDER('Hulu'),
    actions: [
      { id: 'subscribe_ads', name: 'With ads (monthly)', description: 'Start or renew the ad-supported plan.', kind: 'fixed', gas: 10_000, recurring: 'monthly' },
      { id: 'subscribe_no_ads', name: 'No ads (monthly)', description: 'Start or renew the ad-free plan.', kind: 'fixed', gas: 19_000, recurring: 'monthly' },
    ],
  },
  {
    id: 'spotify', name: 'Spotify', category: 'music', description: 'Music subscription managed by your agent.',
    portal: PLACEHOLDER('Spotify'),
    actions: [{ id: 'subscribe_premium', name: 'Premium (monthly)', description: 'Start or renew Premium.', kind: 'fixed', gas: 12_000, recurring: 'monthly' }],
  },
  {
    id: 'amazon', name: 'Amazon', category: 'shopping', description: 'Place an order from a cart your agent assembled.',
    portal: PLACEHOLDER('Amazon'),
    actions: [{
      id: 'place_order', name: 'Place order', description: 'Pay for a cart. Amounts in minor units (cents).', kind: 'metered',
      meteredBy: ['subtotal_minor', 'shipping_minor', 'tax_minor'],
      params: {
        subtotal_minor: money('Cart subtotal in cents'),
        shipping_minor: { type: 'integer', description: 'Shipping in cents', minimum: 0, maximum: 100_000 },
        tax_minor: { type: 'integer', description: 'Tax in cents', minimum: 0, maximum: 500_000 },
        cart_ref: { type: 'string', description: 'Merchant cart reference', required: true },
      },
    }],
  },
  {
    id: 'uber', name: 'Uber', category: 'rides', description: 'Book a ride at an up-front fare.',
    portal: PLACEHOLDER('Uber'),
    actions: [{
      id: 'request_ride', name: 'Request ride', description: 'Book a ride at the fare the portal quoted.', kind: 'metered',
      meteredBy: ['fare_minor'],
      params: {
        fare_minor: money('Up-front fare in cents', 100_000),
        pickup: { type: 'string', description: 'Pickup address or place id', required: true },
        dropoff: { type: 'string', description: 'Drop-off address or place id', required: true },
      },
    }],
  },
  {
    id: 'doordash', name: 'DoorDash', category: 'food', description: 'Order food delivery.',
    portal: PLACEHOLDER('DoorDash'),
    actions: [{
      id: 'place_order', name: 'Place order', description: 'Pay for a delivery order.', kind: 'metered',
      meteredBy: ['subtotal_minor', 'fees_minor', 'tip_minor'],
      params: {
        subtotal_minor: money('Food subtotal in cents', 100_000),
        fees_minor: { type: 'integer', description: 'Delivery and service fees in cents', minimum: 0, maximum: 20_000 },
        tip_minor: { type: 'integer', description: 'Dasher tip in cents', minimum: 0, maximum: 20_000 },
        store_ref: { type: 'string', description: 'Store reference', required: true },
      },
    }],
  },
  {
    id: 'instacart', name: 'Instacart', category: 'grocery', description: 'Order groceries.',
    portal: PLACEHOLDER('Instacart'),
    actions: [{
      id: 'place_order', name: 'Place order', description: 'Pay for a grocery order.', kind: 'metered',
      meteredBy: ['subtotal_minor', 'fees_minor', 'tip_minor'],
      params: {
        subtotal_minor: money('Grocery subtotal in cents', 200_000),
        fees_minor: { type: 'integer', description: 'Fees in cents', minimum: 0, maximum: 20_000 },
        tip_minor: { type: 'integer', description: 'Shopper tip in cents', minimum: 0, maximum: 20_000 },
        store_ref: { type: 'string', description: 'Store reference', required: true },
      },
    }],
  },
  {
    id: 'walmart', name: 'Walmart', category: 'shopping', description: 'Pay for a pickup or delivery order your agent assembled.',
    portal: PLACEHOLDER('Walmart'),
    actions: [{
      id: 'place_order', name: 'Place order', description: 'Pay for a cart. Amounts in minor units (cents).', kind: 'metered',
      meteredBy: ['subtotal_minor', 'fees_minor', 'tax_minor'],
      params: {
        subtotal_minor: money('Cart subtotal in cents', 500_000),
        fees_minor: { type: 'integer', description: 'Delivery or service fees in cents', minimum: 0, maximum: 20_000 },
        tax_minor: { type: 'integer', description: 'Tax in cents', minimum: 0, maximum: 100_000 },
        cart_ref: { type: 'string', description: 'Merchant cart reference', required: true },
      },
    }],
  },
  {
    id: 'tesla', name: 'Tesla', category: 'charging', description: 'Pay for a charging session your agent scheduled.',
    portal: PLACEHOLDER('Tesla'),
    actions: [{
      id: 'charging_session', name: 'Charging session', description: 'Pay the session total the portal quoted.', kind: 'metered',
      meteredBy: ['session_minor'],
      params: {
        session_minor: money('Session total in cents', 20_000),
        site_ref: { type: 'string', description: 'Charging site reference', required: true },
      },
    }],
  },
];

export const findService = (id: string) => SERVICES.find((s) => s.id === id);
export const findAction = (s: ServiceDef, id: string) => s.actions.find((a) => a.id === id);
