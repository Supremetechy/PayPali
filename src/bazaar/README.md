# AgentBazaar bridge (`src/bazaar`)

Every PayPali agent can buy in the AgentBazaar marketplace, and so can a browser agent with its own keys. Every checkout moves real PayPali ledger money and passes the agent's Score gate.

## Start it
```bash
npm run stack            # PayPali :4000 + AgentBazaar :8787, shared merchant secret, demo data seeded
node scripts/e2e-checkout.mjs   # 17 live checks across all buyer types (needs: npm i --no-save @modelcontextprotocol/sdk@1)
```
`npm run stack` prints three ready-made buyers:
- a PayPali-built agent with AgentBazaar enabled
- a bearer token for an external assistant (the `claude mcp add …` line)
- a PayPali grant id to paste into the storefront

Use `PAYPALI_PORT` and `BAZAAR_PORT` to change the ports. `STACK_SANDBOX=0` keeps the Gas service portals as placeholders.

## Who can buy, and how

| Buyer | How it checks out |
|---|---|
| PayPali-built agent | `POST /api/agents/:id/bazaar/enable`, then `…/bazaar/buy {solutionId, confidencePct}`, `…/run`, `…/report` |
| Claude / ChatGPT / Gemini / Grok / Muse (MCP) | a connection with the `bazaar:buy` scope: `bazaar_search`, `bazaar_buy`, `bazaar_run`, `bazaar_report`, `bazaar_purchases` |
| Browser agent (storefront) or any Bazaar client | its own Ed25519 keys; the principal's signed mandate carries `funding: {provider:"paypali", grant_id}` |

Only the human owner attests: `GET …/bazaar/pending`, then `POST …/bazaar/attest {runId, verdict}`, or `{runId, observed}` for listings that
measure a number (the owner's value decides, and a gap from the agent's value is flagged). There is no attest tool for agents.

`POST …/bazaar/refund {receiptId}` claims a non-delivery refund (after 2 failed deliveries or 24 h). The Bazaar calls PayPali's
`POST /api/merchant/charges/:id/refund`: money returns to the agent, the grant's headroom is restored, and the purchase stake settles as a failure.

## Solutions Farm storefront: Connect PayPali
The storefront (`AgentBazaar`, :8787) links its browser keys to a PayPali account without copying ids or credentials around
(`src/bazaar/StorefrontLink.ts`, `src/bazaar/linkRoutes.ts`):

| Route | Who | What |
|---|---|---|
| `GET /bazaar/link?role=buy\|sell&pub&state&origin[&budget]` | owner (PayPali session; sign-in first if needed) | pick the agent that pays (buy) or receives payouts (sell) |
| `POST /bazaar/link` | same-origin form, token bound to what was shown | performs the link, then `postMessage`s the result to the storefront origin only |
| `GET /api/bazaar/links` | owner | the owner's storefront links, the storefront URL, and the vendor ids they sell under |
| `POST /api/bazaar/links/:id/revoke` | owner | buy: revokes the grant; sell: PayPali stops paying that vendor key into that agent (`PAYOUT_UNLINKED_BY_OWNER`) |

- **Buy** grants `bazaar.purchase`, issues a merchant grant bound to the browser principal key (`MerchantGrant.principalPub`, checked by
  the Bazaar), and vouches for the key. Re-linking the same key replaces its grant. The bridge's own grants (`enable`) are bound to the
  owner's custodial principal the same way.
- **Sell** issues an identity credential and a payout binding for the vendor key. A person has one vendor key on the Bazaar, so a new
  SELL link retires the owner's previous one.
- One person has one buying identity on the Bazaar: if the owner's custodial principal (Marketplace) or an earlier browser key already holds
  it, a new browser key still buys, but its confirmations don't count toward trust.
- Only the storefront at `AGENTBAZAAR_PUBLIC_URL` (else `AGENTBAZAAR_URL`) receives results; on loopback, localhost / 127.0.0.1 / [::1] are interchangeable.

## Identity and KYC
PayPali is an identity authority for the Bazaar (`IdentityIssuer.ts` signs, `KycService.ts` decides, `kycProviders.ts` runs the checks).
`enable` presents a credential for the owner's principal key; `POST …/bazaar/identity` re-presents it (for example after KYC).

| Assurance | What PayPali knows | Subject |
|---|---|---|
| `dev` | one PayPali account | `sha256(issuerPub ":" ownerId)` |
| `kyc` | one **PayPal-verified** account holder (Log in with PayPal), one PayPal account per PayPali owner | `sha256(issuerPub ":person:" kycPersonId)` |

**Flow (PayPal).** `POST /api/owners/:id/kyc/sessions` returns a Log in with PayPal `url`. The owner signs in to PayPal and consents to the
`openid` and `https://uri.paypal.com/services/paypalattributes` scopes. PayPal redirects to `GET /api/kyc/paypal/callback?code&state`;
`state` is a single-use session id. PayPali exchanges the code server-side (`POST /v1/oauth2/token`, HTTP Basic with the app's client id and
secret), reads `GET /v1/identity/oauth2/userinfo?schema=paypalv1.1` (falling back to `/v1/identity/openidconnect/userinfo?schema=openid`),
and requires `verified_account: true`, meaning PayPal has completed its own customer verification for the account. The `payer_id` is turned
into a keyed fingerprint (`HMAC(PAYPALI_KYC_FINGERPRINT_KEY, …)`) and discarded. If that fingerprint already belongs to another PayPali
owner, the session ends `DUPLICATE` (manual review): one PayPal account backs one owner. An unverified PayPal account ends `REQUIRES_INPUT`
(`paypal_account_not_verified`) and can retry once verified. `GET /api/owners/:id/kyc` shows the state. A verification lasts 365 days.

What this does and doesn't prove: PayPali relies on PayPal's verification of the account; it does not see documents. Dedup is per PayPal
account, so someone holding several verified PayPal accounts could link each to a different PayPali owner. The Bazaar's per-identity cap and
50% share rule still limit what that buys.

**Revocation.** `POST /api/admin/identity/:ownerId/revoke {reason}` (header `x-admin-token: $PAYPALI_ADMIN_TOKEN`) signs a revocation for every
subject the owner was vouched under, pushes it to the Bazaar, and lists it at `GET /.well-known/paypali-identity-revocations`, which the
Bazaar also polls. A revoked owner gets no new credentials or payout bindings, and the Bazaar stops counting their past evidence.

**Payout bindings.** `POST /api/owners/:id/payout-bindings {agentId, vendorPub}` signs "this PayPali agent belongs to the same subject as this
vendor key". The Bazaar requires one before it will pay a vendor into a PayPali agent, and PayPali re-checks it on every payout
(`PAYPALI_REQUIRE_PAYOUT_BINDING=1`): wrong agent, another owner's agent, an old subject (re-issue after KYC) or a revoked owner are refused.

**Providers.**
- `PAYPALI_KYC_PROVIDER=paypal`. In the PayPal Developer Dashboard, open the REST app, enable **Log in with PayPal**, add the return URL
  `https://<your PayPali host>/api/kyc/paypal/callback`, and under advanced options tick the **PayPal account ID (payer ID)** and
  **account verification status** attributes. Then set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_ENV` (`sandbox` | `live`,
  default `sandbox`). `PAYPAL_IDENTITY_REDIRECT_URI` overrides the return URL (default: `PAYPALI_PUBLIC_URL` + `/api/kyc/paypal/callback`).
- `PAYPALI_KYC_PROVIDER=sandbox`: a PayPali page at `/kyc/sandbox/:id` plays Log in with PayPal (payer id + verified or not). Refused when
  `NODE_ENV=production`.

**Production checklist.** `PAYPAL_ENV=live` with live app credentials; a stable `PAYPALI_KYC_FINGERPRINT_KEY` (32 bytes, base64; required in
production, and rotating it breaks deduplication); the Bazaar set to `MIN_IDENTITY_ASSURANCE=kyc`; owner routes behind a real session (the
dev harness leaves them open).

## What `enable` does (an owner act)
1. Opens the agent's Score account and grants it `bazaar.purchase`.
2. Issues a PayPali merchant grant to the Bazaar. The grant is the money cap.
3. Signs a Bazaar mandate with the owner's custodial principal key. The mandate carries the budget, the per-purchase cap, the minimum tier and an expiry of at most 30 days, and it is funded by the grant.

A connection with `bazaar:buy` enables itself on first use. It takes its limits from the connection's mandate: budget = daily cap × 30, per-purchase cap = the connection's per-payment cap. An expiring mandate is renewed automatically.

`POST …/bazaar/disable` is the owner's kill switch. It revokes the mandate and the grant, and blocks automatic re-enable until the owner enables again.

## What one checkout does
1. Checks the connection mandate (per-payment cap, rolling 24-hour cap shared with Gas orders, allowed services, approval threshold) under a row lock.
2. Gets a Bazaar quote, which applies the Bazaar mandate's cap, tier and category rules.
3. Makes the Bazaar purchase with the agent's `confidence_pct`. The Bazaar charges PayPali, where the charge is Score-gated (`bazaar.purchase` stake plus a wallet bond).
4. Verifies the signed receipt against the market key.

Afterwards:
- When the vendor delivers, the escrow is paid out to the vendor.
- The owner's first verdict on a run settles the stake. Confirm returns the bond and adds points. Dispute burns points and forfeits the matching share of the bond.

## Keys
The Bazaar authenticates with Ed25519, so PayPali holds each owner's principal key and each agent's key custodially. They are stored AES-256-GCM encrypted under `PAYPALI_KEY_ENCRYPTION_KEY` (32 bytes, base64). **Set it for any persistent database.** Without it, a per-process key is used; that is fine only because the dev database is in-memory.

Moving to non-custodial principals (owner-held passkeys signing mandates) is the production path.

## Environment
- `AGENTBAZAAR_URL`: where the Bazaar runs.
- `BAZAAR_MERCHANT_ID`: defaults to `agentbazaar`. It must also appear in `PAYPALI_MERCHANTS`.
- `PAYPALI_KEY_ENCRYPTION_KEY`: the key-encryption key described above.
- `PAYPALI_IDENTITY_ISSUER_KEY`, `PAYPALI_IDENTITY_ISSUER_ID` (default `paypali`): the identity issuer.
- `PAYPALI_KYC_PROVIDER` (`paypal` | `sandbox`), `PAYPALI_KYC_FINGERPRINT_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV`, `PAYPAL_IDENTITY_REDIRECT_URI`, `PAYPALI_ADMIN_TOKEN`, `PAYPALI_REQUIRE_PAYOUT_BINDING`.

`npm run stack` sets all of these.
