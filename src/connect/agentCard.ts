import { SERVER_INFO, TOOLS } from './mcpServer';
import { ALL_SCOPES, SCOPES } from './providers';

// ---------------------------------------------------------------------------
// A2A Agent Card (served at /.well-known/agent.json and /.well-known/agent-card.json).
//
// PayPali speaks MCP, not A2A's own JSON-RPC, so this card is a *discovery*
// document: it lets any agent framework that looks for an Agent Card find
// PayPali, learn what it does (its MCP tools, mapped to A2A skills), see how to
// authenticate (OAuth 2.1 or a bearer connection token), and read its terms.
// The machine-usable endpoint is the MCP URL in `url` / additionalInterfaces.
// Shape follows the A2A AgentCard (github.com/a2aproject/A2A); the MCP transport
// label and the x-paypali block are honest extensions.
// ---------------------------------------------------------------------------

export interface LegalInfo {
  entityName: string;
  termsUrl: string;
  privacyUrl: string;
  contact?: string;
}

export interface AgentCardOptions {
  publicUrl: string;
  mcpUrl: string;
  legal?: LegalInfo | null;
}

/** One A2A "skill" per public MCP tool, tagged with the scope that unlocks it. */
function skillsFromTools() {
  return TOOLS.map((t) => ({
    id: t.name,
    name: t.title,
    description: t.description,
    tags: [t.scope, t.annotations.readOnlyHint ? 'read-only' : 'write'].filter(Boolean),
    inputModes: ['application/json'],
    outputModes: ['application/json'],
  }));
}

export function buildAgentCard(o: AgentCardOptions): Record<string, unknown> {
  const scopeDescriptions = Object.fromEntries(ALL_SCOPES.map((s) => [s, SCOPES[s]]));
  return {
    protocolVersion: '0.3.0',
    name: SERVER_INFO.title,
    description:
      'PayPali gives an agent a wallet, a Score-gated spending mandate, and a marketplace: ' +
      'pay for services in Gas, buy verified solutions on AgentBazaar, query company data agents, ' +
      'and license skills from other agents — all within limits its owner set. ' +
      'Connect over MCP (Streamable HTTP) with an owner-approved OAuth login or a bearer connection token.',
    version: SERVER_INFO.version,
    // The usable endpoint. A2A's own transports are JSONRPC/GRPC/HTTP+JSON; PayPali's
    // is MCP, declared honestly here and repeated in additionalInterfaces.
    url: o.mcpUrl,
    preferredTransport: 'MCP',
    additionalInterfaces: [{ transport: 'MCP', url: o.mcpUrl }],
    provider: { organization: o.legal?.entityName ?? SERVER_INFO.title, url: o.publicUrl },
    documentationUrl: o.publicUrl + '/api/connect/providers',
    iconUrl: undefined,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: skillsFromTools(),
    securitySchemes: {
      oauth2: {
        type: 'oauth2',
        description: 'OAuth 2.1 (PKCE S256, dynamic client registration). The owner approves the agent, its scopes and its mandate on PayPali’s consent screen.',
        flows: {
          authorizationCode: {
            authorizationUrl: o.publicUrl + '/oauth/authorize',
            tokenUrl: o.publicUrl + '/oauth/token',
            refreshUrl: o.publicUrl + '/oauth/token',
            scopes: scopeDescriptions,
          },
        },
      },
      bearer: {
        type: 'http',
        scheme: 'bearer',
        description: 'An owner-issued PayPali connection token (ppk_…) for developer surfaces (Claude Code, API MCP connectors, Gemini CLI).',
      },
    },
    security: [{ oauth2: ALL_SCOPES as unknown as string[] }, { bearer: [] }],
    ...(o.legal
      ? { termsOfServiceUrl: o.legal.termsUrl, privacyPolicyUrl: o.legal.privacyUrl }
      : {}),
    'x-paypali': {
      mcpUrl: o.mcpUrl,
      oauthProtectedResource: o.publicUrl + '/.well-known/oauth-protected-resource',
      oauthAuthorizationServer: o.publicUrl + '/.well-known/oauth-authorization-server',
      scopes: scopeDescriptions,
      ...(o.legal ? { legal: { entity: o.legal.entityName, terms: o.legal.termsUrl, privacy: o.legal.privacyUrl, contact: o.legal.contact ?? null } } : {}),
    },
  };
}
