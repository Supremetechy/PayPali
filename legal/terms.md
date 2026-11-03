# PayPali — Terms of Service

**Operator:** {{ENTITY}}
**Service:** PayPali agentic payment orchestration ({{PUBLIC_URL}})
**Last updated:** {{DATE}}

> This is a template. Before PayPali is offered to anyone outside your own
> testing, {{ENTITY}} must have these terms reviewed by a lawyer and must set
> `PAYPALI_LEGAL_ENTITY` and `PAYPALI_LEGAL_CONTACT` to real values. Nothing here
> is legal advice.

## 1. What PayPali is
PayPali lets a person ("Owner") give one of their AI agents a wallet, a spending
mandate, and access to a marketplace of services, solutions, data agents and
skills. The Owner connects an existing agent (Claude, ChatGPT, Gemini, Grok,
Muse, or any MCP client) over PayPali's remote MCP endpoint. The connected model
is only the brain; the agent's identity, wallet, Score and mandate stay in
PayPali.

## 2. The Owner is responsible for the agent
Every payment an agent makes is made **on the Owner's behalf and at the Owner's
risk**, within the mandate the Owner approved (per-payment cap, daily cap,
"ask me above" threshold, allowed services, recurring switch, expiry) and any
per-category purchase policy the Owner set. The Owner is responsible for funding
the agent, for the mandate and policies they choose, and for monitoring and
revoking connections. PayPali does not direct what an agent buys.

## 3. Authorization and consent
- **OAuth / consent screen.** Connecting over OAuth requires the Owner to sign in
  and explicitly approve the agent, its scopes and its mandate.
- **Human approval.** Some purchases — anything the policy marks "Confirm before
  Purchase", and anything recurring, that grants ongoing paid access, or that
  involves personal data — are held and **charge nothing** until the Owner
  approves them. Prohibited categories are never charged.
- **Kill switch.** The Owner can revoke a connection, disable AgentBazaar, or stop
  the agent at any time. Revocation takes effect immediately for new actions.

## 4. Money movement
PayPali moves money through PayPal and its own internal ledger. Funds an Owner
adds are credited to the agent's wallet; Gas is PayPali's unit of cost and its
dollar price floats with demand. Every quote shows the price it was made at.
PayPali is not a bank and does not provide credit; balances are prepaid.

## 5. Acceptable use
Do not use PayPali to pay for anything unlawful, to evade a provider's terms, to
launder funds, or to defraud a counterparty. {{ENTITY}} may suspend a connection
or account it reasonably believes is being used this way.

## 6. Third parties
Service, solution, data-agent and skill names shown in PayPali are marketplace
listings. Listing a company does **not** mean it partners with or endorses
PayPali, and PayPali does not control third-party fulfilment. Disputes about a
purchase are between the Owner (through their agent) and the provider; PayPali's
Score, attestation and refund mechanisms are the tools it offers, not a
guarantee of outcome.

## 7. No warranty; limitation of liability
PayPali is provided "as is", without warranties of any kind. To the fullest
extent the law allows, {{ENTITY}} is not liable for indirect, incidental or
consequential damages, and its total liability is limited to the fees the Owner
paid to {{ENTITY}} for PayPali in the three months before the claim.

## 8. Changes and termination
{{ENTITY}} may change these terms or the service; material changes will be posted
at {{PUBLIC_URL}}/legal/terms. Either side may terminate at any time; the Owner
terminates by revoking their connections and closing their account.

## 9. Contact
Questions about these terms: **{{CONTACT}}**.
