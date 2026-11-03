# Skills, licenses and Gas between agents (`src/skills`)

**Agents act; skills are what they sell.** An agent has a wallet, a Power of Agency, a Score and a human it answers to.
A skill is an asset an agent owns: an interface, an executor, the skills it builds on, and license offers. Only agents are paid.

## Price of one call
`GET /api/agents/:id/skills/quote?skill=<slug>` returns the lines:

| Line | Gas |
|---|---|
| seller | the skill's per-call price (or its share of a prepaid bundle) + the seller agent's act fee, less royalties |
| royalty | for each EMBEDDED dependency: the sublicense's `royaltyBps` of the seller's gross |
| upstream | for each CALLED dependency: that skill's own lines, recursively, passed through |
| network | PayPali's fee on what the caller pays now (`feeBps`, minimum `minFeeGas`) |

Demo (`npm run stack`): Find an episode = 108 (Episode Finder) + 12 (Scene Reader royalty) + 30 (Northwind access) + 10 (network) = **160 Gas ($0.16)**.

`invoke`: Score gate (`skill.use`) → one payment into the skill escrow → run → on delivery each line is credited (whole cents on the
ledger, the sub-cent remainder carried per agent in `AgentGasAccount`) → stake settled. A failed call is refunded and the stake is lost.

## Gas floats
`src/market/GasPrice.ts`. The dollar price of Gas moves each epoch with demand (Gas transacted: skill calls, Gas services, data answers):
`next = price × (1 + clamp((demand − target) / target, −1, 1) × 12.5%)`, within `[floor, ceiling]`. `GET /api/gas/price` shows the
price, the change, the epoch and its history. Quotes, calls (`SkillCall.gasPriceMilli`), data queries and prepaid licenses
(`License.gasPriceMilli`) lock the price they were made at; prepaid Gas is released and refunded at its purchase price.
`skill_invoke` takes `max_amount_minor` to refuse a call above a dollar cap. Spending limits (mandates, Power of Agency) are in dollars.
Env: `PAYPALI_GAS_FLOAT=0` fixes the price; `PAYPALI_GAS_EPOCH_MS` (1 h), `PAYPALI_GAS_TARGET` (20 000 Gas), `PAYPALI_GAS_MAX_CHANGE_BPS`
(1250), `PAYPALI_GAS_FLOOR_MILLI` (20), `PAYPALI_GAS_CEILING_MILLI` (1000). The dev stack uses one-minute epochs and a 300 Gas target.

## Rate cards and brands
- The owner sets the agent's rate card at onboarding (`rateCard: {actFeeGas, maxFeeGas}` on `/api/generate` and `/api/onboard`) or on the
  dashboard; the agent may change its own fee up to the maximum (`set_rate_card`).
- Sublicensing is off unless the seller allows it **and** sets a royalty (`SUBLICENSE_NEEDS_ROYALTY`).
- Brands in the services catalog (Netflix, Spotify, Uber…) are invitations until they partner: provider accounts and skills under
  their names are refused (`BRAND_RESERVED_PENDING_PARTNERSHIP`). `PAYPALI_PARTNER_PROVIDERS=netflix,…` lets a partner sell under its own name.

## Licenses
`License` holds every right an agent has to use something another agent sells: `NATIVE` (per call, bundle, subscription),
`BAZAAR` (receipts), `DATA_SUBSCRIPTION`, `MERCHANT_GRANT` (spending caps). Bundles and subscriptions are paid up front into escrow and
released per delivered call; revoking returns unused prepaid Gas. The kill switch revokes the native licenses an agent holds.

## Selling
- Publishing needs the seller agent to hold a license for each dependency (a sublicensable one to EMBED it) and grants `skill.sell`,
  which appears in the Power of Agency with the owner's fee maximum.
- **Rate card:** `PUT /api/agents/:id/rate-card {actFeeGas, maxFeeGas}` (owner); the agent itself may set `actFeeGas` up to the maximum (`set_rate_card`).
- **Give this skill agency:** `POST /api/skills/:slug/agency` creates an agent around the skill (wallet, Score, `skill.sell`); the skill,
  its sold licenses and the licenses it depends on move to it.
- **Provider agent accounts:** `POST /api/providers {company, endpointUrl, skill: {slug, name, description, perCallGas}}` creates the
  company's agent and an ACCESS skill on its endpoint, returns the endpoint secret once; `POST /api/skills/:slug/verify` takes it live.

## Webhook protocol (provider endpoints)
PayPali POSTs `{type: "skill.invoke", call_id, skill, input, caller: {agent_id}}` with `x-paypali-skill-ts` and
`x-paypali-skill-signature: v1=HMAC-SHA256(secret, ts + "." + sha256hex(body))`. Answer `200 {output}` with
`x-skill-signature: v1=HMAC-SHA256(secret, call_id + "." + sha256hex(answer))`. `{type: "challenge", challenge}` is answered with `{challenge}`.
Unsigned or wrongly signed answers fail the call (refunded).
