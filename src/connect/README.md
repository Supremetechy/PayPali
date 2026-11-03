# Agent Connect + the Gas marketplace

PayPali agents no longer have to be built inside PayPali. A user's **existing** agent connects through a remote MCP server and acts as one of their PayPali agents. The supported agents are Claude/Cowork, ChatGPT and dots, Gemini, Grok, Meta Muse, and any other MCP client.

The external model is only the brain. The rest stays in PayPali:
- the agent's identity
- its wallet
- its Score
- its knowledge, skills and memory
- the connection's **mandate**

```
Claude / ChatGPT / Gemini / Grok / Muse ──MCP (Streamable HTTP)──▶ PAYPALI_PUBLIC_URL/mcp
        │  bearer token or OAuth 2.1 access token                      │
        └──────────────────────────────────────────────────────────────┤
                         AgentConnection (agent · scopes · mandate)    │
                         ├─ get_agent_context ─▶ AgentDevService (Score, skills, knowledge, memory)
                         ├─ estimate_gas / pay_with_gas ─▶ GasService ─▶ mandate ▶ Score gate ▶ escrow ▶ Agent Portal
                         └─ get_balance ─▶ AgentWalletService
```

## How each assistant connects
`GET /api/connect/providers` returns ready-to-paste setup for each surface, with your URL filled in. The snippets match the vendors' docs as of Oct 2026.

| Assistant | Surface | Auth |
|---|---|---|
| Claude | Claude apps and Cowork: Settings → Connectors → Add custom connector | OAuth |
| Claude | Claude Code: `claude mcp add --transport http paypali <URL> --header "Authorization: Bearer <TOKEN>"` | bearer |
| Claude | Claude API MCP connector: `mcp_servers[].authorization_token` | bearer |
| ChatGPT | ChatGPT apps, used by dots: custom app or connector | OAuth |
| ChatGPT | OpenAI Responses API: `{type:"mcp", server_url, server_label, authorization}` | bearer |
| Gemini | Gemini CLI: `mcpServers.paypali.httpUrl` + `headers` | bearer |
| Grok | xAI API: `{type:"mcp", server_url, server_label, authorization}` (HTTPS only) | bearer |
| Muse | Meta Muse: Settings → Connectors → Add custom connector | OAuth |
| Cursor | `~/.cursor/mcp.json` → `mcpServers.paypali.url` + `headers` | bearer |
| Any | Streamable HTTP MCP client | bearer or OAuth |

Consumer apps connect from the vendor's cloud. For them, **`PAYPALI_PUBLIC_URL` must be a public HTTPS origin**, such as a deployment behind your own domain. `localhost` only works for developer tools running on your machine.

## Connections, scopes and mandates
- **Bearer:** `POST /api/agents/:id/connections {provider, label, scopes, mandate}` returns a `ppk_…` token **once**. PayPali stores only its SHA-256 hash. You can rotate it (`POST /api/connections/:id/rotate`) or revoke the connection (`…/revoke`).
- **OAuth 2.1:**
  1. The client hits `/mcp` and gets a 401 whose `WWW-Authenticate` header points to `/.well-known/oauth-protected-resource`.
  2. It reads `/.well-known/oauth-authorization-server`.
  3. It registers itself (DCR) at `/oauth/register`.
  4. It sends the owner to `/oauth/authorize` (PKCE S256 required). The **consent screen** opens there: the owner picks the agent, the permissions and the mandate.
  5. The client exchanges the code at `/oauth/token`.

  Access tokens last 1 hour. Refresh tokens last 30 days and rotate on every use. Reusing an old refresh token, or replaying a code, revokes the whole connection.
- **Scopes:** `context:read`, `wallet:read`, `market:read`, `gas:quote`, `gas:pay`, `bazaar:buy`. Tools are filtered by scope and checked again at call time. Approving `gas:pay` opens the agent's Score account and grants it the `market.service` capability. Approving `bazaar:buy` does the same for `bazaar.purchase` and unlocks the `bazaar_*` tools (see `src/bazaar/README.md`). The mandate's allowed services can name `agentbazaar`, and the 24-hour cap counts Gas orders and Bazaar purchases together.
- **Mandate** (per connection; it can only narrow what the agent may do):
  - max per payment
  - max per rolling 24 hours
  - "ask me above" (returns `APPROVAL_REQUIRED`)
  - allowed services
  - an expiry

  The mandate is checked under a row lock on the connection, so two parallel payments cannot both slip under the daily limit.

## Gas
Gas is PayPali's unit of cost for agent usage.

| | Formula | Default |
|---|---|---|
| Price of 1 Gas | `gasPriceMilli / 1000` cents | 100, so 1 Gas = $0.001 |
| Network fee | `max(10, ceil(gas × 1.5%))` Gas | |
| Amount paid | `ceil((gas + fee) × price)` | |

Quotes last 5 minutes and are tied to the channel that created them. `pay_with_gas` runs these steps:
1. Check the mandate.
2. Create the order (one per quote, so replaying a payment is safe).
3. Commit a **`market.service` Score stake**: points plus a wallet bond, with the agent's stated `confidence_pct`.
4. Move the Gas from the agent into escrow (the service's settlement account).
5. Call the service's Agent Portal.

The result settles the stake:
- **FULFILLED:** the stake is won.
- **FAILED:** the agent is refunded and the stake is lost.
- **PENDING:** the stake waits for the provider. If the provider never confirms, it expires as a loss.

## The extended marketplace (placeholders)
`src/market/catalog.ts` lists Netflix, Hulu, Spotify, Amazon, Walmart, Tesla (charging), Uber, DoorDash and Instacart. All of them are **placeholders**:
- PayPali has no agreement or integration with these companies.
- The Gas prices are illustrative.
- They can be browsed and quoted, but `pay_with_gas` returns `UNSUPPORTED / PROVIDER_NOT_CONNECTED` before any stake or money moves.

`PAYPALI_SERVICE_SANDBOX=1` (dev only) swaps in a sandbox portal that pretends fulfilment succeeded, so the whole flow can be exercised. Every result from it is marked `sandbox: true`. Pass `sandbox_fail: true` in the params to simulate the provider rejecting the order.

A real provider plugs in as a `ServicePortal` (`src/market/portals.ts`) through `makePortalRegistry({ live: { uber: new UberPortal(...) } })`. It needs a `fulfil(order)` that calls the provider's agent-account API once the Gas is in escrow.

## The marketplace page (`/marketplace`)
The AAAC (Agent as the Customer) marketplace brings everything an owner can pick for an agent into one page, backed by `GET /api/marketplace`:
- **Featured agents**: the top AgentBazaar listings by trust tier, live from the Bazaar (empty when it isn't connected).
- **Connect your agents from**: agent platforms (`src/market/directory.ts`). Claude, ChatGPT, Gemini, Grok, Muse and Cursor have PayPali setup
  guides; Cohere, Replit, Microsoft Copilot, IBM watsonx and Salesforce Agentforce connect as a generic MCP client until a vendor-specific guide exists.
  Opening one creates a connection (token shown once, with the setup snippets).
- **Services**: the Gas catalog above. Opening one quotes an action and pays it with the selected agent; if the agent lacks `market.service`,
  the page offers the owner a one-click grant.
- **Agents & data**: every Bazaar listing, bought with the selected agent (the page offers to enable AgentBazaar first).

**Selections.** `GET/PUT /api/agents/:id/market/selections {items: [{kind: platform|service|bazaar, id}]}` stores an agent's shortlist
(at most 60, validated against the directory and the live Bazaar). They are the default `allowedServices` of the next connection created from
the page (`agentbazaar` is added when any Bazaar listing is selected). They do not restrict purchases on their own; mandates do.

Names are shown as text, never logos, with a disclaimer: listing a company does not mean it partners with or endorses PayPali.

## Environment
- `PAYPALI_PUBLIC_URL`: the origin external agents reach.
- `PAYPALI_MCP_ALLOWED_ORIGINS`: browser origins allowed to call `/mcp`. Server-to-server calls send no Origin header and are always allowed.
- `PAYPALI_SERVICE_SANDBOX=1`: the dev sandbox portals described above.

## Not done yet
- **Real owner login on the consent screen and owner APIs.** The dev server identifies the owner by email with no password. Production also needs CSRF protection.
- **A human-approval flow for `APPROVAL_REQUIRED`.** It should reuse the `HumanApproval` model.
- **Rate limits per connection.**
- **Provider confirmation webhooks.** These would settle `PENDING_PROVIDER` orders.
- **Recurring-charge mandates for subscriptions.**
- **An A2A Agent Card.**
- **The stdio MCP server (`src/mcp`).** It still runs as a single in-process agent; the remote endpoint here is the one to give external agents.
