import { PROVIDERS } from '../connect/providers';
import { SERVICES } from './catalog';

// ---------------------------------------------------------------------------
// Marketplace directory: everything an owner can pick for an agent, in one list.
//
//   platform  where a customer agent comes FROM (it connects to PayPali over MCP)
//             guided       PayPali has a vendor-specific setup guide (providers.ts)
//             generic_mcp  connects as "Any MCP client"; no vendor-specific guide yet
//   service   a merchant the agent pays in Gas (catalog.ts; placeholder portals
//             until a provider ships an Agent Portal)
//   bazaar    an AgentBazaar listing (agents, solutions and data sold by vendors);
//             listed live from the Bazaar, not here
//
// Names are the companies' own trademarks, used only to say what a connector or
// portal is for. Listing does not imply a partnership: `affiliation` is 'none'
// for every entry until an agreement exists.
// ---------------------------------------------------------------------------

export type SelectionKind = 'platform' | 'service' | 'bazaar' | 'data' | 'skill';

export interface PlatformEntry {
  id: string;
  name: string;             // product
  vendor: string;           // company
  blurb: string;
  connect: 'guided' | 'generic_mcp';
  providerId: string;       // PROVIDERS id used when creating the connection
}

export const PLATFORMS: PlatformEntry[] = [
  { id: 'claude', name: 'Claude', vendor: 'Anthropic', blurb: 'Claude apps, Cowork, Claude Code and the Claude API.', connect: 'guided', providerId: 'claude' },
  { id: 'chatgpt', name: 'ChatGPT', vendor: 'OpenAI', blurb: 'ChatGPT apps and the OpenAI Responses API / Agents SDK.', connect: 'guided', providerId: 'chatgpt' },
  { id: 'gemini', name: 'Gemini', vendor: 'Google', blurb: 'Gemini CLI, and the Gemini app where custom apps are available.', connect: 'guided', providerId: 'gemini' },
  { id: 'grok', name: 'Grok', vendor: 'xAI', blurb: 'Grok app connectors and the xAI API remote MCP tool.', connect: 'guided', providerId: 'grok' },
  { id: 'deepseek', name: 'DeepSeek', vendor: 'DeepSeek', blurb: 'DeepSeek models running in your agent code or an MCP host.', connect: 'guided', providerId: 'deepseek' },
  { id: 'perplexity', name: 'Perplexity', vendor: 'Perplexity', blurb: 'Perplexity custom connectors (Pro and Max).', connect: 'guided', providerId: 'perplexity' },
  { id: 'mistral', name: 'Le Chat', vendor: 'Mistral', blurb: 'Le Chat custom MCP connectors.', connect: 'guided', providerId: 'mistral' },
  { id: 'muse', name: 'Muse', vendor: 'Meta', blurb: 'Meta Muse custom connector.', connect: 'guided', providerId: 'muse' },
  { id: 'cursor', name: 'Cursor', vendor: 'Anysphere', blurb: 'Cursor agents through mcp.json.', connect: 'guided', providerId: 'cursor' },
  { id: 'copilot', name: 'Copilot Studio', vendor: 'Microsoft', blurb: 'Copilot Studio agents with an MCP tool.', connect: 'guided', providerId: 'copilot' },
  { id: 'cohere', name: 'Cohere', vendor: 'Cohere', blurb: 'Cohere agents through a generic MCP client.', connect: 'generic_mcp', providerId: 'custom' },
  { id: 'replit', name: 'Replit', vendor: 'Replit', blurb: 'Replit agents through a generic MCP client.', connect: 'generic_mcp', providerId: 'custom' },
  { id: 'watsonx', name: 'watsonx', vendor: 'IBM', blurb: 'IBM agents through a generic MCP client.', connect: 'generic_mcp', providerId: 'custom' },
  { id: 'agentforce', name: 'Agentforce', vendor: 'Salesforce', blurb: 'Salesforce agents through a generic MCP client.', connect: 'generic_mcp', providerId: 'custom' },
  { id: 'other', name: 'Any MCP agent', vendor: 'Open standard', blurb: 'LangChain, LlamaIndex, Ollama hosts or your own code: anything that speaks MCP.', connect: 'generic_mcp', providerId: 'custom' },
];

for (const p of PLATFORMS) if (!PROVIDERS.some((x) => x.id === p.providerId)) throw new Error(`directory: unknown provider ${p.providerId}`);

export const findPlatform = (id: string) => PLATFORMS.find((p) => p.id === id);

export const DISCLAIMER = 'Company and product names are trademarks of their owners and are shown only to describe what each connector or portal is for. '
  + 'Listing does not mean the company partners with or endorses PayPali. Services marked "placeholder" have no Agent Portal connected yet; their Gas prices are illustrative.';

/** Platforms + services, shaped for the marketplace page. Bazaar listings are merged in by the route (they are live data). */
export function directory(services: Array<{ id: string; name: string; category: string; description: string; portal: { status: string; note: string }; actions: unknown[] }>) {
  return {
    platforms: PLATFORMS.map((p) => ({ ...p, kind: 'platform' as const, affiliation: 'none' as const })),
    services: services.map((s) => ({ ...s, kind: 'service' as const, vendor: s.name, affiliation: 'none' as const })),
    disclaimer: DISCLAIMER,
  };
}

const BAZAAR_ID = /^sf-[\w-]{2,40}$/;
const DATA_SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;
const SKILL_SLUG = /^[a-z0-9][a-z0-9-]{2,59}$/;
export const MAX_SELECTIONS = 60;

/** Validate a selection list. Bazaar ids are checked for shape here and for existence by the caller when the Bazaar is reachable. */
export function validateSelections(items: unknown): Array<{ kind: SelectionKind; id: string }> {
  if (!Array.isArray(items)) throw new Error('SELECTIONS_MUST_BE_ARRAY');
  if (items.length > MAX_SELECTIONS) throw new Error('TOO_MANY_SELECTIONS');
  const seen = new Set<string>(), out: Array<{ kind: SelectionKind; id: string }> = [];
  for (const raw of items) {
    const kind = (raw as any)?.kind, id = String((raw as any)?.id ?? '');
    if (kind === 'platform' && !findPlatform(id)) throw new Error(`UNKNOWN_PLATFORM:${id}`);
    else if (kind === 'service' && !SERVICES.some((s) => s.id === id)) throw new Error(`UNKNOWN_SERVICE:${id}`);
    else if (kind === 'bazaar' && !BAZAAR_ID.test(id)) throw new Error(`BAD_BAZAAR_ID:${id}`);
    else if (kind === 'data' && !DATA_SLUG.test(id)) throw new Error(`BAD_DATA_AGENT:${id}`);
    else if (kind === 'skill' && !SKILL_SLUG.test(id)) throw new Error(`BAD_SKILL:${id}`);
    else if (kind !== 'platform' && kind !== 'service' && kind !== 'bazaar' && kind !== 'data' && kind !== 'skill') throw new Error('BAD_SELECTION_KIND');
    const key = kind + ':' + id;
    if (!seen.has(key)) { seen.add(key); out.push({ kind, id }); }
  }
  return out;
}

/** A connection mandate's allowedServices derived from an agent's selections (services, the Bazaar if any listing is selected, data agents as data:<slug>). */
export function allowedServicesFrom(items: Array<{ kind: SelectionKind; id: string }>) {
  const ids = items.filter((i) => i.kind === 'service').map((i) => i.id);
  if (items.some((i) => i.kind === 'bazaar')) ids.unshift('agentbazaar');
  ids.push(...items.filter((i) => i.kind === 'data').map((i) => `data:${i.id}`));
  if (items.some((i) => i.kind === 'skill')) ids.push('skills');
  return ids;
}
