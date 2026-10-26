import {
  AgentWalletService,
  ReceiveType,
  SendResult,
  WalletMovementResult,
} from '../services/AgentWalletService';

/**
 * Agent Skills Registry surface for money movement, bound to one authenticated
 * agent. Identity comes from the authenticated context, never from skill
 * arguments or model-supplied text: the agent can only move its own money, and
 * an idempotency key is required on every money-moving call.
 *
 * - receive: accept an authorized inbound credit (seed activation, external
 *            PayPal top-up, or a refund). Owner/platform authorized.
 * - spend:   commit balance to an external payment.
 * - send:    transfer balance to another agent.
 */
export interface AuthenticatedAgentContext {
  agentId: string;
  ownerId: string;
}

export class AgentSkills {
  constructor(
    private readonly wallet: AgentWalletService,
    private readonly agent: AuthenticatedAgentContext
  ) {}

  /** payment.get_balance — the agent's spendable balance in a currency. */
  getBalance(currency: string): Promise<bigint> {
    return this.wallet.getBalance(this.agent.agentId, currency);
  }

  /** payment.receive — credit this agent from an authorized inbound source. */
  receive(args: {
    amountMinor: bigint;
    currency: string;
    idempotencyKey: string;
    type?: ReceiveType;
    relatedIntentId?: string;
  }): Promise<WalletMovementResult> {
    return this.wallet.receive({
      agentId: this.agent.agentId,
      amountMinor: args.amountMinor,
      currency: args.currency,
      idempotencyKey: args.idempotencyKey,
      type: args.type,
      relatedIntentId: args.relatedIntentId,
    });
  }

  /** payment.spend — debit this agent's balance for an external payment. */
  spend(args: {
    amountMinor: bigint;
    currency: string;
    idempotencyKey: string;
    relatedIntentId?: string;
  }): Promise<WalletMovementResult> {
    return this.wallet.spend({
      agentId: this.agent.agentId,
      amountMinor: args.amountMinor,
      currency: args.currency,
      idempotencyKey: args.idempotencyKey,
      relatedIntentId: args.relatedIntentId,
    });
  }

  /** payment.send_agent_payment — transfer balance to another agent. */
  send(args: {
    toAgentId: string;
    amountMinor: bigint;
    currency: string;
    idempotencyKey: string;
  }): Promise<SendResult> {
    return this.wallet.send({
      fromAgentId: this.agent.agentId,
      toAgentId: args.toAgentId,
      amountMinor: args.amountMinor,
      currency: args.currency,
      idempotencyKey: args.idempotencyKey,
    });
  }
}
