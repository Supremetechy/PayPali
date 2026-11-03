// ---------------------------------------------------------------------------
// Which existing agents can connect, and how. Every provider reaches PayPali the
// same way — the remote MCP endpoint (Streamable HTTP) at <PUBLIC_URL>/mcp — but
// authenticates differently per surface:
//   bearer: developer surfaces where you can set a header or token yourself
//   oauth:  consumer apps that open PayPali's sign-in + consent screen
// Consumer apps connect from the vendor's cloud, so PAYPALI_PUBLIC_URL must be a
// public HTTPS origin (localhost only works for local developer tools).
// Snippets reflect vendor docs as of Oct 2026; re-check when a vendor changes.
// ---------------------------------------------------------------------------

export type AuthMode = 'bearer' | 'oauth';

export interface Surface {
  id: string;
  name: string;
  auth: AuthMode;
  /** app: a consumer chat app (connector + PayPali sign-in); developer: a CLI/IDE/config file; api: code calling the vendor's API. */
  kind: 'app' | 'developer' | 'api';
  /** One-line setup or config. {URL} and {TOKEN} are substituted. */
  setup: string;
  /** Step-by-step version for people (shown in onboarding and the dashboard). {URL}/{TOKEN} substituted. */
  steps?: string[];
  /** The app reaches PayPali from the vendor's cloud: PAYPALI_PUBLIC_URL must be public HTTPS. */
  needsPublicUrl?: boolean;
  note?: string;
}

export interface Provider {
  id: string;
  name: string;
  vendor: string;
  surfaces: Surface[];
}

export const SCOPES = {
  'context:read': 'Read this agent’s profile, Score, skills, knowledge and memory',
  'wallet:read': 'Read the agent’s wallet balance',
  'market:read': 'Browse marketplace services and orders',
  'gas:quote': 'Price service actions in Gas',
  'gas:pay': 'Pay for services and other agents’ skills with Gas (Score-gated, within the mandate)',
  'bazaar:buy': 'Buy, run and report on AgentBazaar solutions (Score-gated, within the mandate)',
  'data:query': 'Ask company data agents for answers, paying Gas per query (Score-gated, within the mandate)',
} as const;
export type Scope = keyof typeof SCOPES;
export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];
export const DEFAULT_SCOPES: Scope[] = ['context:read', 'wallet:read', 'market:read', 'gas:quote'];

const APP_STEPS = (where: string) => [
  `${where}`,
  'Paste this URL: {URL}',
  'Sign in to PayPali when it asks, pick this agent, and approve its permissions and spending limits.',
  'Ask the assistant: "What is my PayPali balance?" to check it works.',
];

export const PROVIDERS: Provider[] = [
  {
    id: 'claude', name: 'Claude', vendor: 'Anthropic',
    surfaces: [
      { id: 'claude-apps', name: 'Claude app (web, desktop, mobile)', auth: 'oauth', kind: 'app', needsPublicUrl: true,
        setup: 'Settings → Connectors → Add custom connector → paste {URL}. Claude opens PayPali’s sign-in, where you pick the agent and its mandate.',
        steps: APP_STEPS('In Claude, open Settings → Connectors → Add custom connector.') },
      { id: 'claude-code', name: 'Claude Code', auth: 'bearer', kind: 'developer',
        setup: 'claude mcp add --transport http paypali {URL} --header "Authorization: Bearer {TOKEN}"' },
      { id: 'claude-api', name: 'Claude API (MCP connector)', auth: 'bearer', kind: 'api', needsPublicUrl: true,
        setup: [
          'curl https://api.anthropic.com/v1/messages \\',
          '  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \\',
          '  -H "anthropic-beta: mcp-client-2025-11-20" -H "content-type: application/json" \\',
          '  -d \'{',
          '    "model": "claude-opus-5-5", "max_tokens": 1024,',
          '    "messages": [{ "role": "user", "content": "What is my PayPali balance?" }],',
          '    "mcp_servers": [{ "type": "url", "url": "{URL}", "name": "paypali", "authorization_token": "{TOKEN}" }],',
          '    "tools": [{ "type": "mcp_toolset", "mcp_server_name": "paypali" }]',
          '  }\'',
        ].join('\n'),
        note: 'Beta header anthropic-beta: mcp-client-2025-11-20 (mcp-client-2026-09-15 also works on the Claude API and adds tool-list pinning; mcp-client-2025-04-04 is deprecated). Each mcp_servers entry needs exactly one matching mcp_toolset in tools. Anthropic calls PayPali from its servers, so the URL must be public https://.' },
    ],
  },
  {
    id: 'chatgpt', name: 'ChatGPT', vendor: 'OpenAI',
    surfaces: [
      { id: 'chatgpt-apps', name: 'ChatGPT app (custom connector)', auth: 'oauth', kind: 'app', needsPublicUrl: true,
        setup: 'Add PayPali as a custom app/connector with the MCP URL {URL}; ChatGPT signs in through PayPali’s OAuth screen.',
        steps: APP_STEPS('In ChatGPT (web), turn on Developer mode in Settings → Apps & Connectors, then create a connector.'),
        note: 'Custom connectors need a paid ChatGPT plan.' },
      { id: 'openai-responses', name: 'OpenAI Responses API / Agents SDK', auth: 'bearer', kind: 'api', needsPublicUrl: true,
        setup: 'tools: [{ "type": "mcp", "server_label": "paypali", "server_url": "{URL}", "headers": { "Authorization": "Bearer {TOKEN}" }, "require_approval": "never" }]' },
    ],
  },
  {
    id: 'gemini', name: 'Gemini', vendor: 'Google',
    surfaces: [
      { id: 'gemini-cli', name: 'Gemini CLI', auth: 'bearer', kind: 'developer',
        setup: '~/.gemini/settings.json → { "mcpServers": { "paypali": { "httpUrl": "{URL}", "headers": { "Authorization": "Bearer {TOKEN}" } } } }' },
      { id: 'gemini-app', name: 'Gemini app (custom app by URL)', auth: 'oauth', kind: 'app', needsPublicUrl: true,
        setup: 'Add a custom app with the MCP server URL {URL}, then sign in to PayPali.',
        steps: APP_STEPS('In the Gemini app, add a custom app by MCP server URL.'),
        note: 'Limited availability (US, 18+, personal Google accounts, English). Gemini CLI works everywhere.' },
    ],
  },
  {
    id: 'grok', name: 'Grok', vendor: 'xAI',
    surfaces: [
      { id: 'grok-app', name: 'Grok app (bring your own connector)', auth: 'oauth', kind: 'app', needsPublicUrl: true,
        setup: 'Add a custom MCP connector with {URL}, then sign in to PayPali.',
        steps: APP_STEPS('In Grok (web, iOS or Android), open Connectors and add a custom MCP connector.') },
      { id: 'xai-api', name: 'xAI API (remote MCP tool)', auth: 'bearer', kind: 'api', needsPublicUrl: true,
        setup: 'tools: [{ "type": "mcp", "server_url": "{URL}", "server_label": "paypali", "authorization": "{TOKEN}" }]',
        note: 'xAI requires an HTTPS server_url.' },
    ],
  },
  {
    id: 'deepseek', name: 'DeepSeek', vendor: 'DeepSeek',
    surfaces: [
      { id: 'deepseek-agents-sdk', name: 'DeepSeek models in your own agent (OpenAI Agents SDK)', auth: 'bearer', kind: 'api',
        setup: [
          '# pip install openai-agents   ·   export DEEPSEEK_API_KEY=…',
          'import asyncio, os',
          'from openai import AsyncOpenAI',
          'from agents import Agent, Runner, OpenAIChatCompletionsModel',
          'from agents.mcp import MCPServerStreamableHttp',
          '',
          'async def main():',
          '    model = OpenAIChatCompletionsModel(model="deepseek-chat", openai_client=AsyncOpenAI(base_url="https://api.deepseek.com", api_key=os.environ["DEEPSEEK_API_KEY"]))',
          '    async with MCPServerStreamableHttp(name="paypali", params={"url": "{URL}", "headers": {"Authorization": "Bearer {TOKEN}"}}) as paypali:',
          '        agent = Agent(name="steward", instructions="You act for your holder under a PayPali Power of Agency.", model=model, mcp_servers=[paypali])',
          '        print((await Runner.run(agent, "What is my PayPali balance?")).final_output)',
          '',
          'asyncio.run(main())',
        ].join('\n'),
        note: 'DeepSeek’s chat app does not connect to outside tools. Run DeepSeek models in an agent or an MCP-capable host and point it at PayPali.' },
      { id: 'deepseek-host', name: 'DeepSeek in an MCP host (Cline, LM Studio, Cursor…)', auth: 'bearer', kind: 'developer',
        setup: 'mcp.json → { "mcpServers": { "paypali": { "url": "{URL}", "headers": { "Authorization": "Bearer {TOKEN}" } } } }',
        note: 'Select a DeepSeek model in the host; the host makes the PayPali calls.' },
    ],
  },
  {
    id: 'perplexity', name: 'Perplexity', vendor: 'Perplexity',
    surfaces: [
      { id: 'perplexity-app', name: 'Perplexity (custom connector)', auth: 'oauth', kind: 'app', needsPublicUrl: true,
        setup: 'Add a custom remote connector with {URL}, then sign in to PayPali.',
        steps: APP_STEPS('In Perplexity, open Settings → Connectors and add a custom remote connector.'),
        note: 'Custom connectors are on Pro and Max plans.' },
    ],
  },
  {
    id: 'mistral', name: 'Le Chat', vendor: 'Mistral',
    surfaces: [
      { id: 'lechat-app', name: 'Le Chat (custom MCP connector)', auth: 'oauth', kind: 'app', needsPublicUrl: true,
        setup: 'Connectors → + Add Connector → Custom MCP Connector → name "paypali", Server URL {URL}. Le Chat detects PayPali’s OAuth sign-in.',
        steps: APP_STEPS('In Le Chat, open Connectors → + Add Connector → Custom MCP Connector (name it paypali).') },
    ],
  },
  {
    id: 'copilot', name: 'Copilot Studio', vendor: 'Microsoft',
    surfaces: [
      { id: 'copilot-studio', name: 'Copilot Studio agent (MCP tool)', auth: 'bearer', kind: 'developer',
        setup: 'In your agent: Tools → Add a tool → Model Context Protocol → server URL {URL}, authentication API key, header "Authorization", value "Bearer {TOKEN}".',
        note: 'Consumer Copilot has no way to add outside tools; Copilot Studio (makers) does.' },
    ],
  },
  {
    id: 'muse', name: 'Muse', vendor: 'Meta',
    surfaces: [
      { id: 'muse-app', name: 'Meta Muse (custom connector)', auth: 'oauth', kind: 'app', needsPublicUrl: true,
        setup: 'Settings → Connectors → Add custom connector → paste {URL}, then sign in to PayPali and approve.',
        steps: APP_STEPS('In Muse, open Settings → Connectors → Add custom connector.'),
        note: 'Muse is offered in the US and Canada.' },
    ],
  },
  {
    id: 'cursor', name: 'Cursor', vendor: 'Anysphere',
    surfaces: [
      { id: 'cursor-mcp', name: 'Cursor (mcp.json)', auth: 'bearer', kind: 'developer',
        setup: '~/.cursor/mcp.json (or .cursor/mcp.json in a project) → { "mcpServers": { "paypali": { "url": "{URL}", "headers": { "Authorization": "Bearer {TOKEN}" } } } }' },
    ],
  },
  {
    id: 'custom', name: 'Any MCP client', vendor: '—',
    surfaces: [
      { id: 'mcp-http', name: 'Any Streamable HTTP MCP client (LangChain, LlamaIndex, Ollama hosts, your own code)', auth: 'bearer', kind: 'developer',
        setup: 'POST JSON-RPC to {URL} with header "Authorization: Bearer {TOKEN}". OAuth discovery: {URL} → 401 → /.well-known/oauth-protected-resource.' },
    ],
  },
];

export const findProvider = (id: string) => PROVIDERS.find((p) => p.id === id);
export const findSurface = (surfaceId: string) => { for (const p of PROVIDERS) { const s = p.surfaces.find((x) => x.id === surfaceId); if (s) return { provider: p, surface: s }; } return null; };
/** A public origin the vendors' clouds can reach (not localhost / private / plain http). */
export const isPublicUrl = (u: string) => { try { const x = new URL(u); return x.protocol === 'https:' && !/^(localhost|127\.|10\.|192\.168\.|\[::1\]|0\.0\.0\.0)/.test(x.hostname) && !x.hostname.endsWith('.local'); } catch { return false; } };

/** Guess the provider from a dynamically registered OAuth client's name. */
export function providerFromClientName(name: string): string {
  const n = (name || '').toLowerCase();
  if (/claude|anthropic|cowork/.test(n)) return 'claude';
  if (/chatgpt|openai|dots/.test(n)) return 'chatgpt';
  if (/gemini|google/.test(n)) return 'gemini';
  if (/grok|xai/.test(n)) return 'grok';
  if (/muse|meta/.test(n)) return 'muse';
  if (/cursor/.test(n)) return 'cursor';
  if (/deepseek/.test(n)) return 'deepseek';
  if (/perplexity/.test(n)) return 'perplexity';
  if (/mistral|le ?chat/.test(n)) return 'mistral';
  if (/copilot|microsoft/.test(n)) return 'copilot';
  return 'custom';
}

export function setupFor(providerId: string, url: string, token?: string) {
  const p = findProvider(providerId);
  if (!p) return [];
  const fill = (t: string) => t.replace(/\{URL\}/g, url).replace(/\{TOKEN\}/g, token ?? '<token from PayPali>');
  return p.surfaces.map((s) => ({
    surface: s.id, name: s.name, auth: s.auth, kind: s.kind, needsPublicUrl: !!s.needsPublicUrl,
    setup: fill(s.setup), steps: s.steps ? s.steps.map(fill) : null,
    note: s.note ?? null,
  }));
}
