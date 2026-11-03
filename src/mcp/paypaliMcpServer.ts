import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { OnboardingService } from '../onboarding/OnboardingService';
import { bootDatabase } from '../server/database';
import { AgentWalletService } from '../services/AgentWalletService';
import { LivePaymentService } from '../services/LivePaymentService';
import { SeedFundingWorker } from '../workers/SeedFundingWorker';
import { DevPayPalCommerceGateway } from '../providers/paypal/DevPayPalCommerceGateway';
import { makePayPalCommerceGateway } from '../providers/paypal/PayPalCommerceSdkAdapters';
import { DevBrowserCheckoutDriver } from '../providers/checkout/DevBrowserCheckoutDriver';
import { GstackBrowseCheckoutDriver } from '../providers/checkout/GstackBrowseCheckoutDriver';
import {
  IPayPalFundingGateway,
  SeedFundingRequest,
  SeedFundingResult,
} from '../providers/paypal/IPayPalFundingGateway';
import { IPayPalCommerceGateway } from '../providers/paypal/IPayPalCommerceGateway';
import { IBrowserCheckoutDriver } from '../providers/checkout/IBrowserCheckoutDriver';

// ---------------------------------------------------------------------------
// PayPali MCP server (stdio, dependency-free JSON-RPC 2.0).
//
// This is the "PayPal Agent/MCP connection" for an agent: an MCP client (Claude
// Desktop, an agent framework) connects over stdio and calls tools to move money.
// The connection represents ONE authenticated agent — identity is fixed by the
// server at startup, never taken from tool arguments — so a model cannot spend as
// a different agent by changing a parameter (PayPali spec §3).
//
// Tools: get_balance, pay, checkout, payout, topup. Execution goes through the
// same LivePaymentService the HTTP server uses (fail-closed, idempotent,
// UNSUPPORTED/AMBIGUOUS honored). Uses real PayPal when PAYPAL_CLIENT_ID /
// PAYPAL_CLIENT_SECRET are set, else the dev gateway.
//
// Scope: boots its own in-process PGlite DB (fresh). For production, point
// DATABASE_URL at a shared Postgres so this and the web app share state.
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = '2024-11-05';
const SCHEMA_SQL_PATH = resolve(process.cwd(), 'tests/.generated/schema.sql');

class DevFundingGateway implements IPayPalFundingGateway {
  async captureFromBalance(_r: SeedFundingRequest): Promise<SeedFundingResult> {
    return { status: 'CAPTURED', captureId: `dev_seed_${randomUUID()}` };
  }
}

function jsonReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}
function log(msg: string): void {
  // Logs go to stderr — stdout is the JSON-RPC channel and must stay clean.
  process.stderr.write(`[paypali-mcp] ${msg}\n`);
}

async function bootDb(): Promise<PrismaClient> {
  // Same selection as the HTTP server (src/server/database): PAYPALI_DATABASE_URL →
  // a shared external Postgres (so this and the web app see the same agents, wallets
  // and ledgers), PAYPALI_DATA_DIR → on-disk PGlite, else a fresh in-memory PGlite.
  // Schema/migrations are created or adopted automatically. To drive an agent the web
  // app funded, point both at the same PAYPALI_DATABASE_URL and set PAYPALI_AGENT_ID.
  const { prisma, mode } = await bootDatabase(process.cwd(), process.env, log);
  log(`db=${mode}`);
  return prisma;
}

function toBig(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  throw new Error('INVALID_AMOUNT_MINOR');
}

const TOOLS = [
  {
    name: 'get_balance',
    description: "Get this agent's spendable PayPal wallet balance (minor units) for a currency.",
    inputSchema: { type: 'object', properties: { currency: { type: 'string', default: 'USD' } } },
  },
  {
    name: 'pay',
    description: 'Pay a merchant/payee for an authorized purchase via a PayPal Order (spend).',
    inputSchema: {
      type: 'object',
      required: ['payeeReference', 'amountMinor'],
      properties: {
        payeeReference: { type: 'string', description: 'Payee email or merchant id' },
        amountMinor: { type: 'string', description: 'Amount in minor units, e.g. "1000" = $10.00' },
        currency: { type: 'string', default: 'USD' },
        description: { type: 'string' },
      },
    },
  },
  {
    name: 'checkout',
    description: 'Pay on a website that offers PayPal but gave no Order id (browser-driven checkout).',
    inputSchema: {
      type: 'object',
      required: ['siteUrl', 'amountMinor'],
      properties: {
        siteUrl: { type: 'string' },
        amountMinor: { type: 'string' },
        currency: { type: 'string', default: 'USD' },
        instructions: { type: 'string', description: 'Optional, UNTRUSTED steps' },
      },
    },
  },
  {
    name: 'payout',
    description: 'Send funds to another PayPal receiver via Payouts (external send).',
    inputSchema: {
      type: 'object',
      required: ['receiver', 'amountMinor'],
      properties: {
        receiver: { type: 'string', description: 'Receiver email or payer id' },
        amountMinor: { type: 'string' },
        currency: { type: 'string', default: 'USD' },
        note: { type: 'string' },
      },
    },
  },
  {
    name: 'topup',
    description: 'Capture an authorized inbound PayPal Order into this agent wallet (receive).',
    inputSchema: {
      type: 'object',
      required: ['orderId', 'amountMinor'],
      properties: {
        orderId: { type: 'string' },
        amountMinor: { type: 'string' },
        currency: { type: 'string', default: 'USD' },
      },
    },
  },
] as const;

async function main(): Promise<void> {
  const prisma = await bootDb();
  const wallet = new AgentWalletService(prisma);
  const onboarding = new OnboardingService(prisma);

  const ppId = process.env.PAYPAL_CLIENT_ID;
  const ppSecret = process.env.PAYPAL_CLIENT_SECRET;
  const ppEnv = process.env.PAYPAL_ENV === 'production' ? 'production' : 'sandbox';
  const provider = ppId && ppSecret ? `paypal:${ppEnv}` : 'dev';
  const commerce: IPayPalCommerceGateway =
    ppId && ppSecret
      ? makePayPalCommerceGateway({ clientId: ppId, clientSecret: ppSecret, environment: ppEnv })
      : new DevPayPalCommerceGateway();
  const checkout: IBrowserCheckoutDriver =
    ppId && ppSecret ? new GstackBrowseCheckoutDriver() : new DevBrowserCheckoutDriver();
  const live = new LivePaymentService(prisma, wallet, commerce, checkout);

  // Bind to one agent: an existing id, or onboard + fund a demo agent.
  let agentId = process.env.PAYPALI_AGENT_ID ?? '';
  const currencyDefault = 'USD';
  if (!agentId) {
    const result = await onboarding.generateAgent({
      owner: { email: process.env.PAYPALI_OWNER_EMAIL ?? 'mcp-agent@example.com' },
      objective: { type: 'GROWTH' },
      seed: { amountMinor: 1_000_000n, currency: currencyDefault, fundingSourceReference: 'mcp_seed' },
    });
    agentId = result.agentId;
    // Fund the seed once so the agent can transact immediately.
    const worker = new SeedFundingWorker(prisma, new DevFundingGateway(), { pollIntervalMs: 50 });
    for (let i = 0; i < 20 && (await processedOrFunded(prisma, agentId)) === false; i++) {
      await worker.processNext();
    }
  }
  log(`provider=${provider} agent=${agentId}`);

  async function execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const currency = (args.currency as string) ?? currencyDefault;
    const idempotencyKey = randomUUID();
    switch (name) {
      case 'get_balance':
        return { agentId, currency, availableMinor: await wallet.getBalance(agentId, currency) };
      case 'pay':
        return live.pay({
          agentId, payeeReference: String(args.payeeReference ?? ''), amountMinor: toBig(args.amountMinor),
          currency, description: String(args.description ?? 'agent purchase'), idempotencyKey,
        });
      case 'checkout':
        return live.checkoutOnSite({
          agentId, siteUrl: String(args.siteUrl ?? ''), amountMinor: toBig(args.amountMinor),
          currency, idempotencyKey, instructions: args.instructions as string | undefined,
        });
      case 'payout':
        return live.payoutExternal({
          agentId, receiver: String(args.receiver ?? ''), amountMinor: toBig(args.amountMinor),
          currency, note: String(args.note ?? 'agent payout'), idempotencyKey,
        });
      case 'topup':
        return live.receiveInbound({
          agentId, orderId: String(args.orderId ?? ''), amountMinor: toBig(args.amountMinor),
          currency, idempotencyKey,
        });
      default:
        throw new Error(`UNKNOWN_TOOL:${name}`);
    }
  }

  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg, jsonReplacer) + '\n');
  const reply = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result });
  const fail = (id: unknown, code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue; // ignore malformed lines
    }
    const { id, method, params } = msg;
    try {
      if (method === 'initialize') {
        reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'paypali', version: '0.1.0' },
        });
      } else if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
        // notifications have no id and need no response
      } else if (method === 'tools/list') {
        reply(id, { tools: TOOLS });
      } else if (method === 'tools/call') {
        const result = await execute(params?.name, params?.arguments ?? {});
        reply(id, { content: [{ type: 'text', text: JSON.stringify(result, jsonReplacer, 2) }] });
      } else if (method === 'ping') {
        reply(id, {});
      } else if (id !== undefined) {
        fail(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'INTERNAL_ERROR';
      if (id !== undefined) {
        // Tool errors are returned as a tool result with isError so the model sees them.
        if (method === 'tools/call') {
          reply(id, { content: [{ type: 'text', text: message }], isError: true });
        } else {
          fail(id, -32603, message);
        }
      }
    }
  }
}

/** Has the agent's seed funded (wallet credited)? */
async function processedOrFunded(prisma: PrismaClient, agentId: string): Promise<boolean> {
  const acct = await prisma.agentAccount.findFirst({ where: { agentId } });
  return !!acct && acct.availableMinor > 0n;
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
