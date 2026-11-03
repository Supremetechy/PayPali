# Company data agents

One agent in front of a company's databases. It sells **answers, not rows**: a catalogue of
question types, each with its own price and contract. Buyers' agents pay per query in Gas.
PayPali checks every answer against the published contract before the buyer sees it, holds
the payment until the dispute window closes, and pays the company (and the data sources it
aggregates) in batches.

| Piece | Where |
|---|---|
| Contract parsing, schema validation, metering, privacy checks | `contract.ts` |
| Listing, query flow, disputes, subscriptions, splits, batched settlement | `DataAgentService.ts` |
| HTTP routes | `httpRoutes.ts` |
| MCP tools `data_agents`, `data_quote`, `data_query`, `data_subscribe` | `../connect/mcpServer.ts` (scope `data:query`) |
| Company kit (endpoint, signatures, consent check) + demo "Acme Freight" | `../../scripts/data-agent-kit.mjs` |
| Tests | `../../tests/DataAgents.test.ts` |

## The listing kind

A `DataAgent` (slug, name, endpoint, the company's PayPali agent) with `DataQuestionType`s:

```jsonc
{
  "key": "lane_volume",
  "inputSchema":  { … },                 // JSON-schema subset (no regex), same as AgentBazaar
  "outputSchema": { … },                 // the answer's shape; may not even declare a banned field
  "pricing": { "model": "metered", "baseGas": 20, "perRowGas": 0.02, "perComputeMsGas": 0.01, "maxGas": 400 },
  "freshnessSeconds": 3600,              // as_of may be at most this old
  "accuracyClaim": 0.9,                  // the company stakes Score at this confidence on every answer
  "privacy": { "bannedFields": ["email", "customer_name"], "minAggregation": { "field": "shipments", "min": 5, "rowsPath": "lanes" } },
  "allowedPurposes": ["analytics", "planning"],   // empty = any stated purpose
  "subjectQuery": false                  // true = "data about me": kyc consent, fixed ≤ 100 Gas, no fee
}
```

Registration returns the endpoint's HMAC secret once (stored AES-GCM sealed) and leaves the agent
`PAUSED` until `verify` succeeds: PayPali sends a signed challenge and the endpoint must echo it,
signed. Changing the endpoint pauses it again.

## One query

1. **Before money:** purpose stated and allowed, input valid, data agent active, and for self-queries
   a kyc identity. Failures return `REFUSED` with no row and nothing charged.
2. **Mandate + budget, under locks:** a connection's mandate must allow `data:<slug>` (or `data:*`
   or `*`), within per-payment and rolling-24h caps. With an active subscription the query also
   counts against the monthly budget, and a connection needs **allow recurring** switched on.
3. **Buyer stake** (`data.query`): confidence that the answer is worth paying for.
4. **Escrow the hold:** `maxGas + fee(maxGas)`, moved to `Data escrow: <slug>`.
5. **Signed request** to the company: `x-paypali-data-ts`, `x-paypali-data-signature: v1=HMAC(secret, ts + "." + sha256(body))`.
   Body: `{query_id, data_agent, question_type, input, purpose, max_rows, subject?, consent?}`.
6. **Signed answer:** `{result, usage: {rows, compute_ms}, as_of}` with
   `x-data-agent-signature: v1=HMAC(secret, query_id + "." + sha256(body))`. HTTP 422 `{refused}` declines.
7. **Contract checks:** output schema, banned fields anywhere in the result (case and punctuation
   insensitive), every group ≥ the aggregation floor, freshness, valid usage, rows within `max_rows`.
   A breach is `REFUSED`: full refund, and the company commits and loses a stake at its claimed accuracy.
8. **Meter:** `price = min(maxGas, ceil(base + rows × perRow + ms × perMs))`; fee as for Gas services
   (`max(minFeeGas, ceil(price × feeBps / 10 000))`), waived for self-queries.
9. **Seller stake** (`data.answer`) at `accuracyClaim`, open until the window closes. A company that
   cannot stake cannot sell the answer (`SELLER_CANNOT_STAKE`, full refund).
10. **Answered:** the unused hold is refunded, the buyer's stake settles WON, and a PayPali-signed
    receipt carries purpose, price, usage, `as_of` and `sha256(canon(result))`. PayPali does not
    store the result.

A company refusal, an unreachable endpoint or a bad signature refunds in full without penalising
the seller. `recover()` fails and refunds queries left `PENDING` (crash or hung endpoint); an answer
arriving after that cannot resurrect them.

## Disputes and settlement

- **Dispute** (the buyer's owner, within `disputeWindowHours`, default 24): the query becomes
  `DISPUTED` before any money moves, the buyer is refunded, and the seller's stake is lost.
- **`settleDue()`** (server timer, `PAYPALI_DATA_SETTLE_INTERVAL_MS`, default 60 s) batches `ANSWERED`
  queries past their window, per data agent:
  PayPali fee → `PayPali data fees`; each ACTIVE split gets `shareBps` of the net; the rest goes to the
  company's agent; seller stakes settle WON. The batch and its payout plan are written before any
  transfer, every transfer is idempotent on `(batch, payee)`, and a rerun finishes interrupted batches.

## Revenue splits

The company owner proposes `{payeeAgentId, label, shareBps}`; it is paid only after the payee's owner
accepts. Open splits can't exceed 10 000 bps, a change returns a split to `PENDING`, and either side
can end it. Batches keep the shares they were created with.

## Self-query consent

For `subjectQuery` types the asker's owner must hold a kyc identity (Log in with PayPal, verified
account). PayPali sends the company the issuer-scoped `subject` and a consent document signed by the
identity issuer:

```json
{ "kind": "data_subject_consent", "issuer": "paypali", "subject": "…", "assurance": "kyc", "method": "paypal_verified_account",
  "data_agent": "acme-freight", "question_type": "my_shipments", "query_id": "…", "purpose": "self_access", "iat": 0, "exp": 0 }
```

The company verifies it with the key at `/.well-known/paypali-identity-issuer` (the kit's
`checkConsent` does this) and answers only about that subject. It must map subjects to its own
records, for example by having the customer link once.

## Running it

`npm run stack` registers **Acme Freight** (`acme@paypali.local`) on `:8799` with three question
types, a 1-hour dispute window and settlement every 15 s, and gives the demo connection `data:query`
with allow recurring switched on. It lists under **Marketplace → Data agents**.

A real company runs the kit:

```bash
DATA_AGENT_SECRET=<from registration> PAYPALI_URL=https://paypali.example node scripts/data-agent-kit.mjs
```

| Env | Meaning |
|---|---|
| `PAYPALI_ALLOW_INSECURE_DATA_ENDPOINTS=1` | allow `http://` and local endpoints; dev only. Otherwise calls go through the SSRF-safe fetch (DNS pinned, private ranges refused) |
| `PAYPALI_DATA_REQUIRE_KYC=1` | only kyc-verified owners may register data agents |
| `PAYPALI_DATA_SETTLE_INTERVAL_MS` | settlement and recovery timer |

## Not built yet

- Inference controls across queries: detecting repeated near-identical queries that together
  reconstruct records. Aggregation floors apply per answer, not across answers.
- Per-purpose query budgets for buyers. The purpose is enforced and recorded, but it isn't budgeted.
- Measured accuracy beyond disputes: lab reproduction and verifier measurements, as V2–V4 do for Bazaar listings.
- A company-side UI. Companies use the API and the kit.
