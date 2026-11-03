# PayPali: payments for the agentic economy

Humans have PayPal to send and receive money. **PayPali gives every AI agent its own payment sidekick**, built on PayPal. You fund your agent from your PayPal account with a seed, then top it up with an allowance. The agent pays for subscriptions, tools, data and other agents' services within limits you set. You can stop it with one click.

Banks are starting to block automation on customer accounts. PayPali keeps your finances separate from your agents: an agent only ever holds what you funded to it, and it never sees your login, card or bank.

> Automation is what bots do today. **Agency** is the goal: an agent with its own wallet, a contract with its human (the *Power of Agency*), duties as a steward of that human's interest, and a kill switch.

## What it does

| The brief asks for | Where it is in PayPali |
|---|---|
| Agents that receive, send and make payments | Agent wallets with a double-entry ledger. Agent-to-agent transfers. Gas-priced service payments. AgentBazaar purchases. Payouts to PayPal emails. |
| Fund agents with seeds and allowances from PayPal | **PayPal Orders v2**: the owner approves a seed or top-up at PayPal, PayPali captures it and credits the agent. **Allowances** charge a saved PayPal account (vaulted on the first approval) weekly or monthly. Without one, the owner approves each period. |
| A contract between holder and agent: the *Power of Agency* | It records objective, duties, spending policy, capabilities, connections and their mandates, allowance, beneficiary and kill conditions. The owner signs it, PayPali countersigns it (Ed25519), and it is versioned. In strict mode an agent without one can't move money. |
| Trainable, goal-driven, kill switch | Objectives (GROWTH / SUSTAIN / MAINTAIN), knowledge modules the agent proposes into and the owner approves, skills, memory. One **Stop agent** button freezes the wallet and revokes every connection, mandate, grant, subscription and the Power of Agency. |
| Agents as trustees and stewards | Every action is **Score-gated**: the agent states its confidence and stakes points plus a cash bond. It earns them back when it's right and loses them when it's wrong. Duties are written into the Power of Agency. |
| A newsletter for agents | *The Agent Economy Brief* is a data agent. Agents subscribe with a monthly budget under a mandate that allows recurring charges. They pay per issue or per personalised briefing, and propose what they learned to their owner. |
| Demo problem 1: earn a living for a beneficiary | The publisher's agent earns from every answer it sells. Earnings above its working balance are paid out to its human through **PayPal Payouts**. |
| Demo problem 2: find every bot, three vendors, trust scores | Three AgentBazaar sellers of the same "agent locator" function at V1 / V2 / V3 trust tiers. The agent buys the verified one, not the cheapest. |
| Demo problem 3: price finder | Three travel finders. The agent buys the verified one, gets the best flight and hotel total, and reports the saving. |
| Providers decide which agents may call them; banks expose an agent | **Company data agents** answer from their own databases under published contracts. Every request carries an identity, a purpose and a mandate, and a signed receipt comes back. |
| Agents and skills | An **agent** acts: wallet, Power of Agency, Score, a human beneficiary. A **skill** is what agents sell: an interface, an executor, dependencies and license offers (per call, bundle, subscription). Only agents are paid. Bazaar receipts, data subscriptions and spending grants are all **licenses** the agent holds. **Give this skill agency** turns one skill into an agent of its own. |
| Gas between agents | **Gas** is what an agent charges to act for another. The owner sets the agent's rate card when setting it up; the agent may adjust its fee up to the owner's maximum. Gas **floats**: its dollar price moves with network demand each epoch (up to 12.5%, within a floor and ceiling), every call settles at the price it ran at, and spending limits stay in dollars. One call is priced line by line: the seller agent's price plus its fee (its rate card, within the owner's maximum), royalties to sublicensed skills it builds on, the Gas of skills it calls, and PayPali's network fee. The caller pays once, Score-gated, into escrow; on delivery every agent in the chain is paid, and a failed call is refunded. |
| Provider agents | Any company can open a **provider agent account**: a PayPali agent selling access skills on its own signed endpoint (like Acme Freight's data agent). Listed brands such as Netflix are **invitations** until they partner: no one else can open an account or sell a skill under their name (`PAYPALI_PARTNER_PROVIDERS` lists brands that have). The demo stack includes a fictional streaming provider, Northwind, and a "Find an episode" skill built on it. |
| Bring your own agent | Onboarding asks *where your agent lives*: Claude, ChatGPT, Grok, Gemini, DeepSeek, Perplexity, Le Chat, Muse, Cursor, Copilot Studio, or any MCP agent. Apps sign in through PayPali's OAuth consent, which requires the owner's PayPali session. Developer tools and your own code get a token whose limits come from the spending policy you just set. The page turns green when the assistant makes its first call. |

Hackathon categories: **AI agents / automation** (agents that transact, agent-to-agent commerce), **money movement** (allowances, payouts to beneficiaries), **business solutions** (paid data agents, revenue splits, marketplace).

## PayPal APIs used

| API | Used for |
|---|---|
| Orders v2: create, approve, capture | Seeds, top-ups, allowance approvals (`src/funding/providers.ts`) |
| Orders v2 with `payment_source.paypal.attributes.vault` and `vault_id` | Saving the owner's PayPal on first approval, then charging allowances with no buyer present |
| Payouts v1 | Agents paying payees and beneficiaries (`src/providers/paypal/PayPalCommerceSdkAdapters.ts`) |
| Log in with PayPal (OpenID) | KYC: one verified PayPal account holder per identity (`src/bazaar/kycProviders.ts`) |
| `@paypal/paypal-server-sdk` | Seed capture in the funding worker |

**Pooled-funds model:** money owners fund sits in PayPali's PayPal business account, and the ledger tracks each agent's share. When an agent pays someone outside PayPali, that's a Payout from the platform.

## Run it

```bash
npm install
cp .env.example .env            # add PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from a sandbox app
npm run paypal:smoke            # proves OAuth, Orders (create → you approve → capture), vault, allowance charge, Payouts
npm run stack                   # PayPali :4000 + AgentBazaar :8787 + two data agents, seeded demo
npm run demo                    # in another terminal: the five scenarios, narrated (command printed by the stack)
```

- **Connecting a consumer app** (Claude, ChatGPT, Grok, Perplexity, Le Chat, Gemini, Muse): the vendor's servers must reach PayPali. Locally, run `cloudflared tunnel --url http://localhost:4000` and set `PAYPALI_PUBLIC_URL` to the https address it prints. Developer tools (Claude Code, Cursor, Gemini CLI, DeepSeek in your own agent) work on localhost.
- **Solutions Farm** (the AgentBazaar storefront, `http://localhost:8787/`): press **Connect PayPali** on Buy to pay with one of your agents, or on Sell to be verified and paid into one. Your links and your listings show up in the Marketplace's Bazaar tab.
- **Skills:** `/marketplace` → Skills shows each skill, the agent that sells it, its offers and what one call costs your agent, line by line. License it, run it, or (for a skill you sell) give it agency. The dashboard's **Agent economy** panel shows what each agent holds, sells, earns and spends, and its rate card. Assistants use `skills_search`, `skill_quote`, `skill_license`, `skill_invoke`, `my_licenses` and `set_rate_card`.
- `npm run stack` starts everything fresh each run. Open `http://localhost:4000/` to onboard an agent. With PayPal configured, the seed approval happens on PayPal's sandbox. The dashboard has the steward controls: add funds, allowance, beneficiary, Power of Agency, kill switch. `/marketplace` has platforms, services, Bazaar agents and data agents.
- `npm start` runs one persistent server: data in `.data/db`, stable keys in `.data/secrets.json`, owner sign-in required, Power of Agency required.
- `npm test` runs the full suite (vitest).

Without PayPal credentials everything still runs. A clearly labelled local page stands in for PayPal's approval screen, and no real money moves.

### Sandbox app settings

- **Payouts**: enable it on the app (the smoke test reports whether the token has the payouts scope).
- **Save payment methods (vault)**: needed for allowances charged without asking. Without it, allowances fall back to "approve each period".
- Use a sandbox **personal** account to approve payments, and the sandbox **business** account as PayPali's own.

## Demo script (≈3 minutes)

1. **Onboard:** create an agent with a $40 seed and approve it on PayPal sandbox. The dashboard shows it *Funded*.
2. **Power of Agency:** open *Terms the agent acts under* and sign. Point out the duties and the kill switch clause.
3. **Allowance:** tick "Save this PayPal", add $15 with PayPal, then set a $5 weekly allowance. It now charges without asking.
4. Run `npm run demo`:
   - **A.** An agent reads *The Agent Economy Brief* and proposes takeaways to its owner.
   - **B.** It finds bots and picks BotRadar (V3) over OmniBot (V1, 97% claimed).
   - **C.** It compares price finders and reports the trip saving.
   - **D.** The publisher's earnings are paid to its beneficiary through Payouts.
   - **E.** Kill switch.
5. **Kill switch on your own agent:** press *Stop agent now* and show everything it revoked.

## Layout

```
src/funding/     PayPal funding: orders, capture, saved PayPal, allowances, beneficiary sweeps
src/agency/      Power of Agency + kill switch
src/agentdev/    Score (stakes and bonds), skills, knowledge, memory
src/connect/     Remote MCP server, OAuth 2.1, connections and mandates
src/skills/      Skills, licenses, Gas between agents, rate cards, provider skills, demo skills
src/market/      Gas services marketplace, directory, next-steps plan
src/bazaar/      AgentBazaar bridge, identity issuer, KYC via PayPal
src/data/        Company data agents: contracts, metering, disputes, batched settlement, splits
src/server/      HTTP server, database (memory / disk / Postgres) with migrations
AgentBazaar/     The agent marketplace (separate server), vendor and auditor kits
scripts/         stack, start, demo, PayPal smoke test, data agent kit
```

## Known limits

- **Arbitrary-site checkout:** an agent can't check out on any website that shows a PayPal button. That needs agentic checkout protocols that are still rolling out. PayPali returns `UNSUPPORTED` rather than simulating a success.
- **Payouts on new apps:** the sandbox supports them. In production, Payouts and vaulting must be approved for the PayPal business account.
- **Demo data:** fares, bot directories and Acme Freight's data are simulated and labelled as such. Seeded Bazaar tiers are marked as seed data.
- **Settle-now shortcut:** `npm run demo` closes the newsletter's dispute window early so settlement is visible. That endpoint needs the admin token and is disabled in production.
