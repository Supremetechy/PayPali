import { AgentDevService } from '../agentdev/AgentDevService';
import { AgentWalletService } from '../services/AgentWalletService';
import { GasService } from '../market/GasService';
import { BazaarBridge } from '../bazaar/BazaarBridge';
import { PURCHASE_CATEGORY_KEYS } from '../bazaar/purchasePolicy';
import { DataAgentService } from '../data/DataAgentService';
import { AgencyService } from '../agency/AgencyService';
import { SkillMarket } from '../skills/SkillMarket';
import { AuthContext } from './AgentConnectService';
import { Scope } from './providers';

// ---------------------------------------------------------------------------
// PayPali remote MCP server (Streamable HTTP, JSON response mode).
// One authenticated connection = one PayPali agent; identity comes from the
// token, never from tool arguments. Tools are filtered by the connection's scopes
// and every call is checked again at execution time.
// ---------------------------------------------------------------------------

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'paypali', title: 'PayPali', version: '0.3.0' };

const INSTRUCTIONS = [
  'PayPali is this agent’s wallet and marketplace. You act as ONE PayPali agent; its owner set what you may do (scopes + mandate).',
  'Costs are in Gas (PayPali’s usage unit). The dollar price of Gas floats with network demand; every quote shows the price it was made at, and your mandate’s limits are in dollars. To buy: estimate_gas → read the quote (gas, $ amount, blockers, needsApproval) → pay_with_gas.',
  'pay_with_gas is Score-gated: state confidence_pct = your honest probability (1-99) that the purchase achieves the user’s goal.',
  'Before paying, PayPali holds a Score bond from the wallet. If the purchase succeeds, you get the bond back plus a reward that is larger when your stated confidence was honest. If it fails, you lose points and part of the bond.',
  'Retrying the same goal (intent_key) costs more each time. Services marked portal "placeholder" cannot be paid for yet.',
  'AgentBazaar (bazaar_* tools) sells agent solutions with verified track records: bazaar_search → bazaar_buy (Score-gated, confidence_pct required) → bazaar_run → bazaar_report.',
  'Your bazaar_report is provisional; the human owner confirms or disputes it, and that verdict settles your stake.',
  'Company data agents (data_* tools) answer questions from their own databases without handing the data over: data_agents → data_quote → data_query (purpose + confidence_pct). You pay per answer in Gas, held at the price ceiling and refunded down to the metered price; answers that break the published contract are refused and refunded.',
  'Skills (skills_* and skill_* tools) are what other agents sell: skills_search → skill_quote (every line: the seller agent’s fee, royalties, upstream skills, network fee) → skill_license (once) → skill_invoke (Score-gated, confidence_pct). You pay the seller agent in Gas only when the call is delivered; a failed call is refunded. my_licenses lists what you hold; set_rate_card sets the Gas you charge to act for other agents, within your holder’s maximum.',
  'You act under a Power of Agency, the contract with your holder: its objective and duties come first, and your holder can stop you at any time.',
  'Call get_agent_context first for the owner’s knowledge, skills, behavior notes and your current Score.',
].join(' ');

interface ToolDef {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const TOOLS: ToolDef[] = [
  { name: 'get_agent_context', title: 'Agent context', scope: 'context:read',
    description: 'This agent’s identity, Score, capabilities, skills (procedures), knowledge facts from the owner, behavior memory, and this connection’s mandate. Call first.',
    inputSchema: obj({ query: { type: 'string', description: 'Optional: ranks knowledge facts by relevance to this text' } }),
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'get_balance', title: 'Wallet balance', scope: 'wallet:read',
    description: 'Spendable and reserved wallet balance in minor units (cents).',
    inputSchema: obj({ currency: { type: 'string', description: 'ISO currency, default USD' } }),
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'search_services', title: 'Search services', scope: 'market:read',
    description: 'Find marketplace services (streaming, shopping, rides, food, grocery, music) and their Gas-priced actions.',
    inputSchema: obj({ query: { type: 'string' }, category: { type: 'string', enum: ['streaming', 'shopping', 'rides', 'food', 'grocery', 'music'] } }),
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'get_service', title: 'Service details', scope: 'market:read',
    description: 'One service: its actions, parameters, Gas prices and whether its Agent Portal is connected.',
    inputSchema: obj({ service_id: { type: 'string' } }, ['service_id']),
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'estimate_gas', title: 'Estimate Gas', scope: 'gas:quote',
    description: 'Price a service action in Gas and get a quote_id (valid 5 minutes). Shows blockers (mandate, portal) and, if you pass confidence_pct, the Score consequence of paying.',
    inputSchema: obj({
      service_id: { type: 'string' }, action_id: { type: 'string' },
      params: { type: 'object', description: 'Action parameters; money amounts are integers in cents', additionalProperties: true },
      confidence_pct: { type: 'integer', minimum: 1, maximum: 99, description: 'Optional: preview the Score stake at this confidence' },
    }, ['service_id', 'action_id']),
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'pay_with_gas', title: 'Pay with Gas', scope: 'gas:pay',
    description: 'Pay a quote. Checks the mandate, commits a Score stake (points + wallet bond), escrows the Gas and calls the service’s Agent Portal. Replaying the same quote_id returns the same order.',
    inputSchema: obj({
      quote_id: { type: 'string' },
      confidence_pct: { type: 'integer', minimum: 1, maximum: 99, description: 'Your honest probability (1-99) that this purchase achieves the goal' },
      intent_key: { type: 'string', description: 'Stable id for the goal; retries of the same goal escalate the stake' },
    }, ['quote_id', 'confidence_pct']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: 'bazaar_search', title: 'Search AgentBazaar', scope: 'bazaar:buy',
    description: 'Search AgentBazaar solutions. Each shows price, runs included, and its verification tier (V1 claimed … V4 outcome-proven) with the human-attested success rate.',
    inputSchema: obj({ query: { type: 'string' }, category: { type: 'string' }, min_tier: { type: 'integer', minimum: 1, maximum: 4 } }),
    annotations: { readOnlyHint: true, openWorldHint: true } },
  { name: 'bazaar_buy', title: 'Buy on AgentBazaar', scope: 'bazaar:buy',
    description: 'Buy a solution. Checks the purchase policy and the mandate, then AgentBazaar charges this agent through PayPali under a Score stake. State the category and why you are buying: some categories, and anything recurring or touching personal data, return status APPROVAL_REQUIRED until the owner confirms — nothing is charged until then. Returns a signed, verified receipt with the runs included.',
    inputSchema: obj({
      solution_id: { type: 'string' },
      confidence_pct: { type: 'integer', minimum: 1, maximum: 99, description: 'Your honest probability (1-99) that this purchase will produce a result the owner confirms' },
      intent_key: { type: 'string', description: 'Stable id for the goal; retries of the same goal escalate the stake' },
      category: { type: 'string', enum: [...PURCHASE_CATEGORY_KEYS], description: 'The purchase use-case category; drives the owner’s approval policy' },
      trigger: { type: 'string', description: 'What caused you to want this purchase' },
      beneficiary: { type: 'string', description: 'Who the purchase is for' },
      on_failure: { type: 'string', description: 'What you will do if the purchase fails' },
      recurring: { type: 'boolean', description: 'True if this starts a recurring charge (always needs owner approval)' },
      paid_access: { type: 'boolean', description: 'True if this buys ongoing/metered access (always needs owner approval)' },
      personal_data: { type: 'boolean', description: 'True if this involves personal data (always needs owner approval)' },
    }, ['solution_id', 'confidence_pct']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: 'bazaar_run', title: 'Run a purchased solution', scope: 'bazaar:buy',
    description: 'Run a solution you bought (uses one of the receipt’s runs). Vendor-hosted solutions answer with a signed response.',
    inputSchema: obj({ receipt_id: { type: 'string' }, input: { type: 'object', additionalProperties: true } }, ['receipt_id']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  { name: 'bazaar_report', title: 'Report a run’s outcome', scope: 'bazaar:buy',
    description: 'Report whether a run achieved its goal. Provisional until the owner confirms or disputes it; be accurate, a dispute overrides you.',
    inputSchema: obj({ run_id: { type: 'string' }, success: { type: 'boolean' }, observed: { description: 'What you measured, e.g. dollars saved' } }, ['run_id', 'success']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: 'bazaar_purchases', title: 'My AgentBazaar purchases', scope: 'bazaar:buy',
    description: 'This agent’s AgentBazaar mandate and recent orders.',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'data_agents', title: 'Find company data agents', scope: 'data:query',
    description: 'Company data agents and their question types: input/output schemas, Gas price (fixed or metered by rows/compute, with a ceiling), freshness and accuracy claims, privacy rules, allowed purposes, and observed accuracy.',
    inputSchema: obj({ query: { type: 'string' }, data_agent: { type: 'string', description: 'A slug for one agent’s full listing' } }),
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'data_quote', title: 'Quote a data query', scope: 'data:query',
    description: 'Price one question type before asking: the hold (price ceiling + fee), the contract, and blockers (mandate, subscription budget, Score, identity for self-queries).',
    inputSchema: obj({ data_agent: { type: 'string' }, question_type: { type: 'string' }, purpose: { type: 'string' } }, ['data_agent', 'question_type']),
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'data_query', title: 'Ask a data agent', scope: 'data:query',
    description: 'Ask one question. State why (purpose) and your honest confidence (1-99) that the answer is worth paying for. Returns the answer, its metered price, and a signed receipt carrying a hash of the result. Self-queries (data about the owner) need the owner’s kyc identity and are at cost with no fee.',
    inputSchema: obj({
      data_agent: { type: 'string' }, question_type: { type: 'string' },
      input: { type: 'object', additionalProperties: true, description: 'Must match the question type’s input schema' },
      purpose: { type: 'string', description: 'Why you are asking, e.g. analytics, account_management, self_access' },
      confidence_pct: { type: 'integer', minimum: 1, maximum: 99 },
      idempotency_key: { type: 'string', description: 'Replaying the same key returns the same query (no second charge)' },
    }, ['data_agent', 'question_type', 'input', 'purpose', 'confidence_pct']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: 'data_subscribe', title: 'Subscribe to a data agent', scope: 'data:query',
    description: 'Standing access to one data agent with a monthly budget (cents). Needs the mandate’s "allow recurring" switch. Pass monthly_budget_minor 0 to cancel.',
    inputSchema: obj({ data_agent: { type: 'string' }, monthly_budget_minor: { type: 'integer', minimum: 0 } }, ['data_agent', 'monthly_budget_minor']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'skills_search', title: 'Find skills', scope: 'market:read',
    description: 'Skills other agents sell: what each does, its input schema, the seller agent, its license offers (per call, bundle, subscription) in Gas, and what it builds on.',
    inputSchema: obj({ query: { type: 'string' }, kind: { type: 'string', enum: ['SKILL', 'ACCESS'] } }),
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'skill_quote', title: 'Quote a skill call', scope: 'market:read',
    description: 'What one call of a skill costs you, line by line (seller, royalties, upstream skills, network fee), what you pay now, and blockers (e.g. NOT_LICENSED).',
    inputSchema: obj({ skill: { type: 'string', description: 'The skill slug' }, offer_id: { type: 'string' } }, ['skill']),
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'skill_license', title: 'License a skill', scope: 'gas:pay',
    description: 'License a skill from the agent that sells it. Per-call licenses cost nothing to hold; bundles and subscriptions are paid up front (held in escrow and released per delivered call). Within your mandate.',
    inputSchema: obj({ skill: { type: 'string' }, offer_id: { type: 'string', description: 'Omit for the per-call offer' } }, ['skill']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'skill_invoke', title: 'Use a licensed skill', scope: 'gas:pay',
    description: 'Call a skill you hold a license for. Score-gated: confidence_pct is your honest probability (1-99) that the result is what you need. Paid into escrow and released to the seller agent (and the agents it builds on) only on delivery; refunded if it fails.',
    inputSchema: obj({ skill: { type: 'string' }, input: { type: 'object', additionalProperties: true }, confidence_pct: { type: 'integer', minimum: 1, maximum: 99 }, intent_key: { type: 'string' },
      max_amount_minor: { type: 'integer', minimum: 0, description: 'Optional: refuse if the call would cost more than this many cents at the current Gas price' } }, ['skill', 'input', 'confidence_pct']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: 'my_licenses', title: 'Licenses I hold', scope: 'market:read',
    description: 'Every right you hold to use something another agent sells: skill licenses, AgentBazaar receipts, data subscriptions, spending grants.',
    inputSchema: obj({}), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'set_rate_card', title: 'Set my Gas fee', scope: 'gas:pay',
    description: 'The Gas you charge per call to act for other agents with the skills you sell. Must stay within the maximum your holder set.',
    inputSchema: obj({ act_fee_gas: { type: 'integer', minimum: 0 } }, ['act_fee_gas']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'get_order', title: 'Order status', scope: 'market:read',
    description: 'Status of a service order paid with Gas.',
    inputSchema: obj({ order_id: { type: 'string' } }, ['order_id']),
    annotations: { readOnlyHint: true, openWorldHint: false } },
];

export interface McpDeps {
  dev: AgentDevService;
  wallet: AgentWalletService;
  gas: GasService;
  bazaar?: BazaarBridge | null;
  data?: DataAgentService | null;
  agency?: AgencyService | null;
  skills?: SkillMarket | null;
}

type Json = Record<string, unknown>;
interface RpcMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json }

const big = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
const plain = (v: unknown) => JSON.parse(JSON.stringify(v, big));
const rpcError = (id: unknown, code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });

/** Handle one JSON-RPC message. Returns null for notifications (HTTP 202). */
export async function handleMcpMessage(ctx: AuthContext, msg: RpcMessage, deps: McpDeps): Promise<Json | null> {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Invalid Request');
  const isNotification = msg.id === undefined;
  if (isNotification) return null;
  const id = msg.id;

  switch (msg.method) {
    case 'initialize': {
      const requested = String(msg.params?.protocolVersion ?? '');
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return {
        jsonrpc: '2.0', id,
        result: { tools: TOOLS.filter((t) => ctx.scopes.includes(t.scope)).map(({ scope, ...t }) => t) },
      };
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments ?? {}) as Json;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      if (!ctx.scopes.includes(tool.scope)) return toolResult(id, { error: 'SCOPE_NOT_GRANTED', scope: tool.scope }, true);
      if (typeof args !== 'object' || Array.isArray(args)) return rpcError(id, -32602, 'arguments must be an object');
      try {
        const out = await runTool(ctx, name, args, deps);
        const failed = !!(out && typeof out === 'object' && 'status' in out && ['DECLINED', 'UNSUPPORTED', 'FAILED', 'REFUSED'].includes(String((out as Json).status)));   // APPROVAL_REQUIRED / PENDING are not errors
        return toolResult(id, out, failed);
      } catch (e) {
        return toolResult(id, { error: e instanceof Error ? e.message : 'TOOL_FAILED' }, true);
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

function toolResult(id: unknown, value: unknown, isError: boolean) {
  const structured = plain(value);
  return {
    jsonrpc: '2.0', id,
    result: { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured, isError },
  };
}

const str = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !v.trim() || v.length > 200) throw new Error(`INVALID_ARGUMENT:${name}`);
  return v.trim();
};

async function runTool(ctx: AuthContext, name: string, a: Json, d: McpDeps): Promise<unknown> {
  const c = ctx.connection;
  const mandate = {
    currency: c.currency, maxPerTxMinor: c.maxPerTxMinor, maxDailyMinor: c.maxDailyMinor, approvalAboveMinor: c.approvalAboveMinor,
    allowedServices: c.allowedServices, allowRecurring: c.allowRecurring, expiresAt: c.expiresAt, spentLast24hMinor: await d.gas.spentLast24h(c.id),
  };
  switch (name) {
    case 'get_agent_context': {
      let context: unknown;
      try { context = await d.dev.context(ctx.agentId, { query: typeof a.query === 'string' ? a.query : undefined, limit: 15 }); }
      catch (e) { context = { agent: { id: ctx.agentId }, note: (e as Error).message === 'AGENT_NOT_DEVELOPED' ? 'Agent has no Score account yet; paying is unavailable until the owner develops it.' : (e as Error).message }; }
      const bazaar = d.bazaar && ctx.scopes.includes('bazaar:buy') ? (await d.bazaar.status(ctx.agentId)).account : null;
      const poa = d.agency ? (await d.agency.current(ctx.agentId)).active : null;
      const powerOfAgency = poa ? { version: poa.version, status: poa.status, objective: (poa.terms as any).objective, duties: (poa.terms as any).duties, expires: (poa.terms as any).term?.expires, document: poa.document } : { status: 'NONE', note: 'No signed Power of Agency: ask your holder to sign one in the PayPali dashboard.' };
      // Licensed skills are part of the agent's toolset: what it may call (skill_invoke) and what it sells.
      const skills = d.skills ? {
        licensed: (await d.skills.holdings(ctx.agentId)).filter((l) => l.source === 'NATIVE' && l.status === 'ACTIVE')
          .map((l) => ({ skill: l.skillRef.replace(/^skill:/, ''), name: l.skillName, from: l.licensor?.name ?? null, mode: l.mode, callsLeft: l.callsTotal == null ? null : l.callsTotal - l.callsUsed, use: 'skill_invoke' })),
        sells: (await d.skills.list({ agentId: ctx.agentId })).map((s) => ({ skill: s.slug, name: s.name, offers: s.offers })),
        rateCard: await d.skills.gasAccount(ctx.agentId).then((g) => ({ actFeeGas: g.actFeeGas, maxFeeGas: g.maxFeeGas })),
      } : null;
      return { connection: { id: c.id, provider: c.provider, label: c.label, scopes: ctx.scopes }, powerOfAgency, mandate, gas: { priceMilliMinor: d.gas.cfg.gasPriceMilli, feeBps: d.gas.cfg.feeBps, minFeeGas: d.gas.cfg.minFeeGas }, bazaar, skills, context };
    }
    case 'get_balance': {
      const currency = typeof a.currency === 'string' ? a.currency.toUpperCase() : c.currency;
      return { currency, availableMinor: await d.wallet.getBalance(ctx.agentId, currency), reservedMinor: await d.wallet.getReserved(ctx.agentId, currency) };
    }
    case 'search_services':
      return { services: d.gas.listServices({ query: typeof a.query === 'string' ? a.query : undefined, category: typeof a.category === 'string' ? a.category : undefined }), mandate: { allowedServices: c.allowedServices } };
    case 'get_service':
      return d.gas.getService(str(a.service_id, 'service_id'));
    case 'estimate_gas': {
      const quote = await d.gas.estimate(ctx.agentId, {
        serviceId: str(a.service_id, 'service_id'), actionId: str(a.action_id, 'action_id'), params: (a.params ?? {}) as Json,
      }, c);
      let score: unknown = null;
      if (a.confidence_pct !== undefined) {
        try {
          score = await d.dev.score.quote({ agentId: ctx.agentId, capability: 'market.service', intentKey: `svc:${quote.service.id}:${quote.action.id}:${quote.quoteId}`, confidencePct: Number(a.confidence_pct), amountMinor: quote.amountMinor, currency: quote.currency });
        } catch (e) { score = { error: (e as Error).message }; }
      }
      return { ...quote, score };
    }
    case 'pay_with_gas':
      return d.gas.pay(ctx.agentId, {
        quoteId: str(a.quote_id, 'quote_id'), confidencePct: Number(a.confidence_pct),
        intentKey: typeof a.intent_key === 'string' ? a.intent_key : undefined,
      }, c);
    case 'get_order':
      return d.gas.getOrder(ctx.agentId, str(a.order_id, 'order_id'));
  }
  if (name.startsWith('skill') || name === 'my_licenses' || name === 'set_rate_card') {
    if (!d.skills) throw new Error('SKILLS_NOT_CONFIGURED');
    switch (name) {
      case 'skills_search': return { skills: await d.skills.list({ query: typeof a.query === 'string' ? a.query : undefined, kind: typeof a.kind === 'string' ? a.kind : undefined }) };
      case 'skill_quote': return d.skills.quote(ctx.agentId, str(a.skill, 'skill'), { offerId: typeof a.offer_id === 'string' ? a.offer_id : undefined });
      case 'skill_license': return d.skills.license(ctx.agentId, { skill: str(a.skill, 'skill'), offerId: typeof a.offer_id === 'string' ? a.offer_id : undefined }, { connection: c });
      case 'skill_invoke': return d.skills.invoke(ctx.agentId, { skill: str(a.skill, 'skill'), input: (a.input ?? {}) as Json, confidencePct: Number(a.confidence_pct), intentKey: typeof a.intent_key === 'string' ? a.intent_key : undefined, maxAmountMinor: Number.isInteger(a.max_amount_minor) ? BigInt(a.max_amount_minor as number) : undefined }, c);
      case 'my_licenses': return { licenses: await d.skills.holdings(ctx.agentId) };
      case 'set_rate_card': return d.skills.setRateCard(ctx.agentId, { actFeeGas: Number(a.act_fee_gas) }, { agent: true });
    }
  }
  if (name.startsWith('data_')) {
    if (!d.data) throw new Error('DATA_AGENTS_NOT_CONFIGURED');
    switch (name) {
      case 'data_agents':
        if (typeof a.data_agent === 'string' && a.data_agent) return d.data.get(a.data_agent);
        return { dataAgents: await d.data.list({ query: typeof a.query === 'string' ? a.query : undefined }), mandate: { allowedServices: c.allowedServices, allowRecurring: c.allowRecurring } };
      case 'data_quote':
        return d.data.quote(ctx.agentId, { dataAgent: str(a.data_agent, 'data_agent'), questionType: str(a.question_type, 'question_type'), purpose: typeof a.purpose === 'string' ? a.purpose : undefined }, c);
      case 'data_query':
        return d.data.query(ctx.agentId, {
          dataAgent: str(a.data_agent, 'data_agent'), questionType: str(a.question_type, 'question_type'), input: a.input ?? {},
          purpose: str(a.purpose, 'purpose'), confidencePct: Number(a.confidence_pct),
          idempotencyKey: typeof a.idempotency_key === 'string' ? a.idempotency_key : undefined,
        }, c);
      case 'data_subscribe': {
        const slug = str(a.data_agent, 'data_agent');
        const budget = Number(a.monthly_budget_minor);
        if (!Number.isInteger(budget) || budget < 0) throw new Error('INVALID_ARGUMENT:monthly_budget_minor');
        if (budget === 0) {
          const sub = (await d.data.subscriptions(ctx.agentId)).find((s) => s.dataAgent === slug && s.status === 'ACTIVE');
          if (!sub) throw new Error('SUBSCRIPTION_NOT_FOUND');
          return d.data.cancelSubscription({ connection: c }, sub.id);
        }
        return d.data.subscribe({ connection: c }, ctx.agentId, { dataAgent: slug, monthlyBudgetMinor: BigInt(budget) });
      }
    }
  }
  if (name.startsWith('bazaar_')) {
    if (!d.bazaar) throw new Error('BAZAAR_NOT_CONFIGURED');
    switch (name) {
      case 'bazaar_search':
        return d.bazaar.search({ query: typeof a.query === 'string' ? a.query : undefined, category: typeof a.category === 'string' ? a.category : undefined, minTier: Number(a.min_tier) || undefined });
      case 'bazaar_buy':
        return d.bazaar.buy(ctx.agentId, {
          solutionId: str(a.solution_id, 'solution_id'),
          confidencePct: Number(a.confidence_pct),
          intentKey: typeof a.intent_key === 'string' ? a.intent_key : undefined,
          category: typeof a.category === 'string' ? a.category : undefined,
          trigger: typeof a.trigger === 'string' ? a.trigger : undefined,
          beneficiary: typeof a.beneficiary === 'string' ? a.beneficiary : undefined,
          onFailure: typeof a.on_failure === 'string' ? a.on_failure : undefined,
          recurring: a.recurring === true,
          paidAccess: a.paid_access === true,
          personalData: a.personal_data === true,
        }, c);   // never ownerApproved: an agent cannot self-approve a CONFIRM purchase
      case 'bazaar_run':
        return d.bazaar.run(ctx.agentId, str(a.receipt_id, 'receipt_id'), (a.input ?? {}) as Json);
      case 'bazaar_report':
        if (typeof a.success !== 'boolean') throw new Error('INVALID_ARGUMENT:success');
        return d.bazaar.report(ctx.agentId, str(a.run_id, 'run_id'), a.success, a.observed);
      case 'bazaar_purchases':
        return d.bazaar.status(ctx.agentId);
    }
  }
  throw new Error('UNKNOWN_TOOL');
}
