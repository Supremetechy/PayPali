# PayPali — Privacy Policy

**Operator:** {{ENTITY}}
**Service:** PayPali agentic payment orchestration ({{PUBLIC_URL}})
**Last updated:** {{DATE}}

> This is a template. Before PayPali handles anyone's data outside your own
> testing, {{ENTITY}} must have this policy reviewed against the privacy law that
> applies to it (e.g. GDPR, CCPA) and set real contact details. Nothing here is
> legal advice.

## 1. What PayPali stores
- **Owner account:** email address and the sign-in sessions tied to it.
- **Agents:** name, objective, wallet balances, Score, knowledge/skills/memory
  the Owner gives them, and the mandate on each connection.
- **Connections:** which assistant is connected, its scopes and mandate. Only
  **SHA-256 hashes** of connection tokens and OAuth codes are stored, never the
  plaintext.
- **Transactions:** quotes, orders, charges, receipts and ledger entries needed
  to run and reconcile payments.
- **Identity (KYC):** PayPali stores **no raw identity documents or PII**. A
  verified person is a row plus keyed HMAC fingerprints used only to stop one
  person from verifying several accounts. "Log in with PayPal" returns a payer id
  that is reduced to a keyed hash and discarded.

## 2. Secrets
Encryption keys, signing keys and provider credentials are held as secrets
(environment variables or mounted secret files), never committed to source, and
excluded from logs. Vaulted payment references and endpoint secrets are sealed at
rest.

## 3. How data is used
To operate the service: authenticate Owners, enforce mandates and policies, move
and reconcile money, compute Score, and show Owners what their agents did. PayPali
does **not** sell personal data.

## 4. Sharing
- **Payment providers** (e.g. PayPal) receive what is needed to move money.
- **Marketplace counterparties** (services, solutions, data agents, skills)
  receive the request an agent makes and a signed receipt — not the Owner's
  account data. Company data agents answer questions and return answers, never
  the underlying rows.
- **Legal** disclosure only where required by law.

## 5. Retention
Account, transaction and audit records are kept while the account is open and for
as long afterward as the law and reconciliation require, then deleted or further
anonymised.

## 6. Owner rights
Depending on where the Owner lives, they may have rights to access, correct,
export or delete their data, and to object to or restrict processing. Requests go
to **{{CONTACT}}**.

## 7. Contact
Privacy questions or requests: **{{CONTACT}}**.
