# Merchant Connect (`src/merchant`)

This is how an outside store such as AgentBazaar takes money from a PayPali agent and pays its vendors. Every charge passes the agent's Score gate.

## Setup
`PAYPALI_MERCHANTS='[{"id":"agentbazaar","secret":"<16+ chars>","webhookUrl":"https://bazaar.example/v1/paypali/webhooks"}]'`
Each merchant gets a settlement agent (`merchant+<id>@paypali.system`). That agent holds purchase escrow and pays vendors.

## Owner endpoints (dev harness, unauthenticated)
- `POST /api/agents/:id/merchant-grants {merchantId, maxMinor, currency, expiresAt?}` lets one merchant draw up to `maxMinor` from one agent.
- `GET /api/agents/:id/merchant-grants`
- `POST /api/merchant-grants/:id/revoke` revokes the grant immediately and queues a `grant.revoked` webhook to the merchant.

## Merchant API (HMAC: `x-paypali-merchant`, `x-paypali-timestamp`, `x-paypali-signature: v1=HMAC(secret, ts.METHOD.path.sha256(body))`, ±5 min)
| Call | Effect |
|---|---|
| `GET /api/merchant/grants/:id` | The merchant's view of its own grant (remaining, status). Other merchants' grants return 404. |
| `POST /api/merchant/charges {grantId, amountMinor, currency, idempotencyKey, reference, score:{intentKey, confidencePct, ttlMs?}}` | Reserves on the grant, then commits a **`bazaar.purchase` stake** (points plus a wallet bond), then transfers agent → settlement. Returns 200 PAID or 402 DECLINED with reasons, plus the Score quote when the gate refused. Idempotent per merchant key. A crash midway resumes on replay. |
| `POST /api/merchant/charges/:id/outcome {success, evidence}` | Settles that charge's stake exactly once (WON releases the bond, LOST forfeits it to the Score Pool). |
| `POST /api/merchant/payouts {toAgentId, amountMinor, currency, idempotencyKey}` | Pays settlement → vendor agent. Idempotent. |
| `GET /api/merchant/balance?currency=USD` | Settlement balance. |

The charge is refused before any money moves if the agent:
- is not developed
- lacks `bazaar.purchase`
- is on probation for a non-LOW action
- is out of attempts for this goal
- cannot cover the price plus the bond

If the transfer itself fails after the stake was committed, the stake settles as a loss.

## Webhooks to the merchant
These come from the durable `MerchantEvent` outbox, written in the same transaction as the state change. Headers are `x-paypali-event-id` and
`x-paypali-signature: t=<ms>,v1=HMAC(secret, t.event_id.sha256(body))`. Failed deliveries retry with exponential backoff and are marked FAILED after 10 attempts.
Events so far: `grant.revoked`.
