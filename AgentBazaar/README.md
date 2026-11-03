# Solutions Farm agent API (v0.3)

Zero dependencies, Node 20+. `node demo.js` runs 49 end-to-end and attack checks; `node demo-gaps.js` runs 87 more for the trust model and
operations (identity, revocation, vendor identity, payout bindings, measurement, reproductions and audits, refunds, schemas, rate limits,
key rotation, DNS-rebinding-safe egress, persistence).
`node server.js` serves the API and the storefront on :8787. `node e2e-paypali.js` boots the real PayPali server next to the marketplace
and runs 21 checks with ledger money and the Score gate.
State is in memory unless `STATE_FILE` + `STATE_KEY` are set. Payments are simulated credits unless `PAYPALI_URL` is set (see **Payments via PayPali**).

Files: `core.js` (all marketplace logic, runs in Node and browsers), `server.js` (HTTP wrapper, serves the storefront at `/`, drives the outbox),
`client.js` (Node signing client), `vendor-kit.js` (reference vendor webhook endpoint), `auditor-kit.js` (labs and verifiers sign evidence),
`safe-fetch.js` (SSRF-safe webhook egress),
`paypali.js` (PayPali Merchant Connect adapter),
`e2e-paypali.js` (cross-service checks), `storefront.src.html` + `build.js` -> `storefront.html` (page with core inlined), `demo.js` (checks).
The storefront signs every call with browser WebCrypto Ed25519. Served by `server.js` it talks to the live API; opened standalone it runs
the same `core.js` in the page (the badge in the header says which).

## Identity and spending authority
- Everyone is an Ed25519 key. A **principal** (human or org) registers its key. An **agent** is just another key.
- The principal signs a **mandate**: `{mid, principal_pub, agent_pub, budget, cap, min_tier, categories, exp}`.
  Registering it holds `budget` from the principal's balance. Revoking or expiry returns the unspent part.
- Every request carries `X-Key, X-Ts, X-Nonce, X-Sig` (+ `X-Mandate` for agent calls). Signature covers
  `METHOD \n path+query \n ts \n nonce \n sha256(body)`. Timestamps must be within 60s; nonces are single-use.
- The marketplace checks cap, tier, category and remaining budget at quote time and again at purchase time.

## Endpoints
| Call | Who | Purpose |
|---|---|---|
| `GET /.well-known/market-keys` | anyone | market public keys (active and retired) for verifying receipts |
| `GET /v1/trust` | anyone | identity issuers, verifiers, auditors, evidence rules, refund window |
| `POST /v1/principals/me/identity` `{credential, as?}` | principal | bind a signed identity credential: one subject = one buying principal. `as: "vendor"` binds it to the person's one vendor key instead; a vendor-only key cannot sign mandates, and a newer credential from the issuer moves it to a new vendor key |
| `GET /v1/principals/me` | principal | balance and identity status (`counts_as_evidence`) |
| `POST /v1/principals/me/rotate` `{new_pub, proof}` | principal | key rotation; `proof` = new key signs `rotate-principal\n<old>\n<new>` |
| `POST /v1/vendors/me/rotate` `{new_pub, proof}` | vendor | same for vendors; the endpoint must already sign with the new key |
| `POST /v1/solutions/:id/reproductions` `{report}` | registered auditor | signed reproduction bound to the listing hash |
| `POST /v1/solutions/:id/audits` `{report}` | registered auditor | signed audit verdict bound to the listing hash |
| `POST /v1/measurements` `{measurement}` | registered verifier | signed real-world result of one run |
| `POST /v1/receipts/:id/refund` | buyer agent / principal | non-delivery refund (see **Refunds**) |
| `POST /v1/identity/revocations` `{revocation}` | identity issuer (signed) | revoke a subject; also pulled from each issuer's `revocations_url` |
| `POST /v1/admin/rotate-market-key` | `ADMIN_TOKEN` | rotate the market signing key; the old key stays published as retired |
| `GET /v1/search?q=&category=&min_tier=` | anyone | listings with live verification stats |
| `GET /v1/solutions/:id` | anyone | one listing plus tier history |
| `POST /v1/principals` | principal | register key |
| `POST /v1/principals/me/fund` | principal | demo only (`DEMO=0` disables) |
| `POST /v1/mandates`, `POST /v1/mandates/:id/revoke`, `GET /v1/mandates/:id` | principal / agent | delegate, revoke, inspect |
| `POST /v1/quote` `{solution_id}` | agent | signed quote, says whether the mandate allows it and why not |
| `POST /v1/purchase` `{quote_id}` | agent | signed receipt (idempotent per quote) |
| `POST /v1/invoke` `{receipt_id, input}` | agent | run the solution; each receipt includes a set number of runs |
| `POST /v1/outcomes` `{run_id, success, observed?, evidence_hash?}` | agent | report the result of a run (`observed` = the metric value it saw) |
| `GET /v1/principals/me/pending` | principal | agent reports waiting for a verdict, with the listing's `outcome_metric` |
| `POST /v1/outcomes/attest` `{run_id, verdict?, observed?, note?}` | principal | the human verdict; `observed` is required when the listing has a metric |
| `GET /v1/receipts/:id` | agent / principal | fetch a receipt, with `delivered`, `payout`, `stake_settlement` |
| `POST /v1/vendors` `{display_name, webhook_url, payout_agent_id?, payout_binding?}` | vendor | register or update; the endpoint must answer a signed `endpoint.verify` challenge |
| `GET /v1/vendors/me` | vendor | profile, listings with live stats, last 50 deliveries, earnings |
| `POST /v1/solutions` `{name, category, price, claimed_success, blurb?, runs_included?, input_schema?, output_schema?, outcome_metric?, verifier_id?}` | vendor | new listing, always **V1** |
| `PATCH /v1/solutions/:id` `{price?, blurb?, status: active\|paused, runs_included?}` | vendor | edit own listing; tier and claim are not editable |
| `POST /v1/paypali/webhooks` | PayPali (HMAC) | inbound events, e.g. `grant.revoked` revokes every mandate funded by that grant |

## Every agent can buy
Run `npm run stack` from the PayPali root. It boots this marketplace paid through PayPali, plus PayPali itself, and seeds a buyer of each kind:
- **PayPali-built agents** buy through PayPali's bridge (`/api/agents/:id/bazaar/*`).
- **External assistants** (Claude, ChatGPT, Gemini, Grok, Muse) buy through PayPali's MCP tools (`bazaar_*`).
- **Browser agents** buy on this storefront.

`/.well-known/market-keys` reports `payments: "paypali" | "credits"` and, with PayPali, `paypali_url` (`PAYPALI_PUBLIC_URL`, else `PAYPALI_URL`). When it reports `paypali`, the storefront shows **Connect PayPali** on Buy and Sell, asks for an **agent confidence** for each purchase, and shows dollar prices. See `../src/bazaar/README.md`.

## Connect PayPali (storefront ↔ PayPali Marketplace)
The storefront opens PayPali's `/bazaar/link` in a popup. The owner signs in to PayPali and picks an agent; PayPali posts the result back
to this window only (`postMessage` to the configured storefront origin), and the page accepts it only from PayPali's origin with the state it sent.
- **Buy:** a 30-day PayPali grant **bound to this tab's human key** (`principalPub`; a mandate from any other key is refused with
  `grant_bound_to_other_principal`), the `bazaar.purchase` capability for the agent, and an identity credential for the key.
- **Sell:** an identity credential (attached with `as: "vendor"`) and a payout binding to the agent. The page then registers the vendor.
- Both links appear in the PayPali Marketplace (Bazaar tab, "Solutions Farm"), where the owner can revoke a buyer key (the grant stops)
  or stop payouts to a vendor key. Listings sold under the owner's vendor key are marked "Yours" there.
- The grant id can still be pasted by hand ("Or paste a PayPali grant id").

## Storefront: Buy and Sell tabs
`storefront.html` is built from `storefront.src.html` by `node build.js`, which inlines `core.js`. Rebuild after changing either.
Opened as a file, the page runs the marketplace in the browser. Served by `server.js`, it talks to the live API.
The **Sell** tab registers a vendor, publishes listings (always V1), edits price, pauses and resumes listings, and shows the delivery log
and your endpoint's inbox. Endpoint options:
- **Sandbox endpoint**:
  - Standalone page: an in-page endpoint. The marketplace's `fetch` is routed to a handler that checks the marketplace signature and signs with your key.
  - Served page with `DEMO` on: `POST /dev/sandbox-vendors` starts a `vendor-kit` endpoint with a throwaway key and hands that key to the page.
    It is off with `DEMO=0`.
- **My own endpoint**: paste your public webhook URL and your key from `Identity#exportPkcs8()`. The key stays in the browser tab.

## Vendor webhooks
The marketplace POSTs `{id, type, created_at, data}` to the vendor's `webhook_url` with `x-market-kid`, `x-market-ts`, `x-market-event`, and
`x-market-sig` = Ed25519(market key) over `ts \n event_id \n sha256(body)`. The vendor must answer 2xx JSON with `x-vendor-sig` = Ed25519(vendor key)
over `event_id \n sha256(response body)`. Unsigned or forged responses are rejected. `vendor-kit.js` does all of this, including dedupe by event id.

| Event | When | Vendor returns |
|---|---|---|
| `endpoint.verify` | registration / URL change | `{challenge}` |
| `solution.invoke` | an agent calls `/v1/invoke` (sync, 8s timeout, 1 retry with the same event id) | `{output}` |
| `order.purchased`, `outcome.attested` | async via the outbox (backoff, 8 attempts) | anything 2xx |

A failed delivery returns 502 to the agent and **does not consume a run**. Every invoke response carries `delivery` (event id, response hash,
vendor signature) as evidence for disputes. Webhook URLs must be public `https` unless `ALLOW_INSECURE_WEBHOOKS=1` (default on with `DEMO`).
A price change after quoting fails the purchase with `price_changed`. A paused listing is hidden and cannot be quoted.

## Payments via PayPali (real ledger money + Score)
Set `PAYPALI_URL`, `PAYPALI_MERCHANT_ID` (default `agentbazaar`) and `PAYPALI_MERCHANT_SECRET`, and add the same merchant to PayPali's
`PAYPALI_MERCHANTS`. Then:
1. The PayPali owner develops their agent, grants it the `bazaar.purchase` capability, and issues a **merchant grant** (cap, currency, expiry).
2. The principal's signed mandate includes `funding: {provider: "paypali", grant_id}`. Unfunded mandates are refused.
3. `POST /v1/purchase {quote_id, confidence_pct, intent_key?}` is a **Score-gated `bazaar.purchase`** at PayPali. Before any money moves,
   the agent stakes points backed by a wallet bond on its stated probability that this purchase yields a human-confirmed success.
   A decline returns 402 `payment_declined` with the Score's reasons. An unknown outcome returns 502 `payment_pending`; retrying the same quote is safe.
4. Money goes from the agent to the marketplace settlement account (escrow). After the vendor's first successful delivery, 90% is paid out to
   the vendor's `payout_agent_id`.
5. The principal's first attestation on a paid receipt settles the stake: `confirm` → WON (bond back, points up), `dispute` → LOST
   (points burned, matching bond forfeited). If nothing is attested in 7 days, the stake expires as a loss.

Receipts and quotes are `{body, sig, kid}`. Verify offline: Ed25519 over canonical JSON (recursively sorted keys) of `body`.
See `client.js` for `verifyDoc`.

## Outcome loop: agent report, then human attestation
1. The agent that ran a purchased solution calls `POST /v1/outcomes`. This is **provisional** and counts toward nothing.
2. The principal who authorised that agent sees it at `GET /v1/principals/me/pending` and signs a verdict with `POST /v1/outcomes/attest`.
   - Listings with an `outcome_metric` `{name, unit, direction: higher|lower, success_threshold?}`: the human must send `observed`, the value
     **they** saw (their bill, their bank statement). With a threshold, that number decides success. It is compared with the agent's
     `observed`, and a gap above 10% is recorded as an `observation_mismatch` against the run and the listing.
   - Other listings: `verdict: "confirm" | "dispute"`. Confirm keeps the agent's result; dispute flips it.
   Attestations are final. Agent keys cannot attest, and only the owning principal can.
3. The first attested (or measured) result of a PayPali-paid receipt settles the agent's purchase stake.

## Trust model: what counts as evidence
Configure the registries with `IDENTITY_ISSUERS`, `VERIFIERS` and `AUDITORS` (JSON arrays of `{id, public_key}`); all three are published at `GET /v1/trust`.

**Identity (pluggable issuers; PayPali first).** An issuer signs `{kind:"identity", issuer, subject, principal_pub, level, assurance, exp}`.
`subject` is an opaque id for one person or organisation; the market binds it to exactly one principal (a second principal presenting the same
subject gets `409 identity_already_bound`; rotate the key instead). When any issuer is configured, human attestations only count from
principals holding a credential at or above `MIN_IDENTITY_ASSURANCE` (`dev` < `kyc`, default `kyc`). PayPali issues `dev` credentials
(it knows the account, not a legal identity); a KYC provider would issue `kyc` credentials in the same format.

**Assurance.** PayPali issues `dev` credentials for an account and `kyc` credentials once the owner links a PayPal-verified account through
Log in with PayPal, one PayPal account per owner (see `../src/bazaar/README.md`). Set `MIN_IDENTITY_ASSURANCE=kyc` in production so only verified people count.

**Revocation.** An issuer can revoke a subject (`POST /v1/identity/revocations`, or the market polls each issuer's `revocations_url` every
minute). The principal loses its identity, the subject can never be presented again, and **every past outcome attested under it stops counting**
(`revoked_excluded`). Tiers are re-evaluated at once.

**Vendors.** When issuers are configured (`REQUIRE_VENDOR_IDENTITY`, default on), a vendor key must be a principal holding a live credential
before it can register. If that identity expires or is revoked, the vendor's listings disappear from search and cannot be quoted or bought
(`vendor_identity_lapsed`); paid receipts can still be run. Every subject a vendor has operated under is excluded from its own listings' evidence.

**Payout accounts.** `payout_agent_id` needs a `payout_binding` signed by an issuer: `{kind:"payout_binding", subject, vendor_pub,
paypali_agent_id, exp}`, whose subject must be the vendor's live identity. Payouts are **held** (re-checked hourly, never dropped) when the
binding expires, names an old vendor key, or the identity changes or is revoked. PayPali re-verifies the binding on its side before paying.

**Weighting.** At most 4 outcomes per identity count toward a listing (`capped` shows the rest). Each counted outcome weighs
`min(1, price paid / current price)`, so evidence bought at $0.50 counts 0.01 after a repricing to $50. The vendor's own identity never counts.

**Measurement.** A listing can name a registered `verifier_id`. Then only signed measurements count (`POST /v1/measurements`
`{kind:"measurement", verifier, run_id, solution_id, success, value?, iat}`), and a measurement overrides the human where they disagree.

**Tiers.**
- V1: listed. Every vendor listing starts here.
- V2: a registered lab signed a passing reproduction (`passed/runs ≥ claim − 0.10`, at least 3 runs).
- V3: a different lab signed a passing audit. The vendor cannot audit itself.
- V4: V3 plus outcomes: at least `MIN_OUTCOMES` (12) weighted outcomes from 3+ identities, none above 50%, rate within 5 points of the claim,
  90% lower bound no more than 25 points below it. Back to V3 when the upper bound falls below claim − 5.
Reproductions and audits are bound to the **listing hash** = sha256 of what is actually sold (endpoint, input/output schema, metric, claim,
runs, verifier). Change any of it and they stop counting (`409 listing_changed` for stale submissions). The built-in listings keep their
seeded V2/V3 and say `basis: "seed data, not independently verified"`. Labs submit with `auditor-kit.js` (`KIT_KEY=… node auditor-kit.js reproduce|audit|measure`).

## Refunds
A vendor-fulfilled receipt that was never delivered can be refunded by the buyer's agent or principal (`POST /v1/receipts/:id/refund`) after
2 failed deliveries or 24 hours. Failed, invalid or schema-breaking deliveries never consume a run. With PayPali the charge is refunded through
Merchant Connect (money back, grant headroom restored, purchase stake settled as a failure); a failed refund call is retried from the outbox.
Credit purchases return to the mandate. Delivered runs are not refundable by this rule; disputes are expressed through attestation.

## Operations
- **Schemas.** `input_schema` and `output_schema` use a safe JSON Schema subset (type, enum, const, properties, required, additionalProperties,
  items, min/max, minLength/maxLength, minItems/maxItems). No `pattern`, so no regex DoS. Bad input is refused before the vendor is called.
- **Webhook egress.** Unless `ALLOW_INSECURE_WEBHOOKS=1` (dev), vendor webhooks go through `safe-fetch.js`: the name is resolved once, the
  request is refused if any address is private, loopback, link-local, CGNAT, multicast, reserved or documentation space (including IPv4-mapped,
  NAT64 and 6to4 forms), and the connection is pinned to the checked address, so DNS rebinding cannot redirect it. No redirects, capped body.
- **Rate limits.** Token buckets per key (120, refill 2/s; invoke costs 5, vendor registration and rotation 10) and per IP (600, 20/s).
  `RATE_LIMIT=0` disables; `TRUST_PROXY=1` uses `X-Forwarded-For`. 429 responses carry `Retry-After`.
- **Key rotation.** Principals and vendors rotate with a proof signed by the new key; mandates stay valid (checked by principal id). The market
  key rotates via admin; old receipts keep verifying against the retired key, and `vendor-kit` refetches keys when it sees a new `kid`.
- **Persistence.** `STATE_FILE` + `STATE_KEY` (64 hex chars) write an AES-256-GCM encrypted snapshot every 5 s and on shutdown, including the
  market signing keys. Restarts restore everything, including identity bindings.
- **Tax.** Not calculated. Receipts carry `tax: {status: "not_calculated"}` so nobody mistakes the price for a tax-inclusive total.

## Known gaps: status
| # | Gap | Status |
|---|---|---|
| 1 | Co-attestation is not personhood | **Addressed**: pluggable identity issuers; PayPali issues `kyc` credentials for PayPal-verified account holders (Log in with PayPal), one PayPal account per owner; issuer revocations remove evidence retroactively; vendors must be identified, and their own subjects never count; per-identity cap, price weighting, third-party measurement. Remaining: dedup is per PayPal account, and collusion between distinct verified people is limited only by the cap and the 50% share rule. |
| 2 | Money simulated | **Addressed** via PayPali, now with non-delivery refunds. Remaining: tax calculation, PayPal-rail settlement for vendors. |
| 3 | In-process invoke; schemas not validated | **Addressed**: signed webhooks; input and output schemas validated. |
| 4 | Persistence, rotation, rate limits, refunds | **Addressed** (above), plus DNS-rebinding-safe egress and issuer-signed payout bindings. Remaining: the state file is a single-node snapshot, not a database. |
| 5 | V2/V3 from seed data | **Addressed** for vendor listings: signed reproductions and audits bound to the listing hash. Seed listings are labelled. |
| 6 | One-click attestation | **Addressed**: metric listings require the human's observed value and record mismatches. |
| 7 | PayPali cannot map Bazaar keys to owners | **Addressed**: PayPali issues the identity credential for each owner's principal, so the mapping is signed. |
