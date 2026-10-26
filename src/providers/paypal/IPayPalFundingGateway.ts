// Seed funding gateway: pulls funds from the human owner's PayPal account
// balance to activate an agent's seed. In production this is backed by PayPal's
// SDKs/APIs (a balance capture / payout against the owner's authorized funding
// source); in tests it is a programmable fake. OnboardingService calls it before
// crediting the agent's wallet, and never treats an unconfirmed capture as
// success — a gateway that cannot capture returns a non-CAPTURED result rather
// than simulating one.

export interface SeedFundingRequest {
  ownerId: string;
  /** Opaque reference to the owner's PayPal funding source, never a raw credential. */
  fundingSourceReference: string;
  amountMinor: bigint;
  currency: string;
  /** Dedupes retries so the owner's PayPal balance is never pulled twice. */
  idempotencyKey: string;
}

export type SeedFundingResult =
  | { status: 'CAPTURED'; captureId: string }
  | { status: 'INSUFFICIENT_FUNDS' }
  | { status: 'FAILED'; reason: string };

export interface IPayPalFundingGateway {
  /** Capture `amountMinor` from the owner's PayPal balance for a seed. */
  captureFromBalance(request: SeedFundingRequest): Promise<SeedFundingResult>;
}
