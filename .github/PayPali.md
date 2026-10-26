PayPali — Agent Payment Skills, Parameters & Safeguards

Document type: Developer Implementation Specification
Product: PayPali — Payments for the Agentic Economy
Status: Proposed architecture and implementation requirements
Audience: Backend engineers, AI-agent developers, security engineers, product architects, and QA teams
1. Product Overview

PayPali is an agentic digital payments solution built on PayPal's trusted infrastructure. It gives AI agents a controlled way to access funds, make authorized purchases, manage subscriptions, acquire digital resources, and transact with other agents.

Humans fund agents through seeds (initial funding) and allowances (ongoing spending permissions). Agents may autonomously execute payments within explicitly granted permissions and policy constraints.

PayPali must ensure that agent autonomy never exceeds the authority granted by the human account holder, the payment platform, or applicable policies.
Core design principles

    Human-authorized autonomy: Agents may act independently only within approved permissions.
    Least privilege: Every agent receives the minimum permissions necessary.
    Bounded spending: Each payment is constrained by available funds, per-transaction limits, and aggregate budgets.
    Explicit authorization: A request from an agent is not, by itself, authorization to move money.
    Defense in depth: Enforce safeguards at the API, policy engine, payment orchestration, and ledger layers.
    Traceability: Every payment decision must be attributable to an agent, its owner, its funding source, and the applicable policy.
    Revocability: Owners must be able to pause an agent, revoke permissions, and stop future spending.
    Fail-safe behavior: Uncertain authorization, policy failures, and suspicious activity must not result in an unapproved payment.

    Implementation note: This document defines a proposed product and engineering specification. It does not assert that any particular PayPal API currently supports these capabilities. Production payment execution must use approved integrations, documented provider capabilities, and the necessary account permissions.

2. System Architecture

Implement PayPali as a policy-controlled payment orchestration layer between AI agents and an approved payment provider.
Logical components

    Agent Identity Service: Registers agents and binds each agent to its owner and permitted execution environment.
    Owner Authorization Service: Records human-approved permissions, funding relationships, spending limits, and revocations.
    Seed and Allowance Manager: Manages funding allocations, available balances, reservations, and budget consumption.
    Agent Skills Registry: Defines the payment operations each agent may request.
    Policy Decision Engine: Evaluates whether an action is allowed before execution.
    Payment Orchestrator: Validates, submits, and tracks authorized payment operations.
    Recipient and Merchant Trust Service: Evaluates recipient identity, destination eligibility, and risk signals.
    Ledger and Reconciliation Service: Records financial state changes and reconciles them with the payment provider.
    Risk and Fraud Service: Detects anomalous transactions, abuse, repeated failures, and suspicious payment patterns.
    Audit and Monitoring Service: Records authorization decisions, execution results, and security events.
    Owner Control Interface: Allows humans to configure permissions, review activity, approve exceptional transactions, and revoke access.

Recommended payment execution flow

    The agent requests a payment skill.
    The skill validates the request schema and agent identity.
    The policy engine loads the applicable owner authorization and allowance.
    The system checks the transaction amount, currency, recipient, category, purpose, budget, and risk.
    If required, the system requests human approval.
    The orchestrator reserves the permitted amount against the appropriate budget.
    The payment provider processes the transaction through an approved integration.
    The system records the provider result and updates the ledger.
    The reservation is finalized or released according to the actual payment outcome.
    The owner and agent receive an appropriate status notification.

Never allow an agent to bypass the policy engine by invoking the payment provider directly.
3. Agent Identity and Authorization Model

Every agent must have a unique, revocable identity.
Required agent attributes
Field	Description
agent_id	Unique, immutable agent identifier
owner_id	Identifier of the authorizing human or organization
status	pending, active, paused, revoked, or disabled
created_at	Agent registration timestamp
permissions	Explicitly granted skills and action scopes
allowance_ids	Allowances available to the agent
risk_profile	Current system-assigned risk classification
policy_version	Version of the applicable authorization policy
expires_at	Optional expiration of the agent authorization
last_activity_at	Timestamp of the most recent activity
Authorization rules

    An agent must not access another owner's funds or allowances.
    An agent cannot grant itself new permissions or increase its own limits.
    An agent cannot transfer its authority to another agent unless the owner explicitly permits that behavior.
    Every privileged operation must verify that the agent is active and its authorization remains valid.
    Revoked permissions must take effect immediately for new authorization decisions.
    Existing in-flight transactions must be handled according to their actual execution state and the provider's supported cancellation or reversal capabilities.
    Agent identity must be independent of the natural-language instructions supplied to the model.

Use cryptographically verifiable service identities and short-lived credentials for internal service-to-service authorization. Do not treat a model-generated statement, tool description, or conversation transcript as proof of authorization.
4. Agent Payment Skills Registry

Skills are discrete, typed capabilities exposed to an agent. Each skill must declare its required permissions, input schema, policy checks, side effects, and error behavior.
4.1 payment.get_balance

Purpose: Retrieve the agent's permitted view of available funds.

Parameters:

    allowance_id — optional allowance to inspect.
    currency — optional currency filter.
    include_reserved — whether to report reserved funds, subject to permission.

Rules:

    Return only balances the agent is authorized to inspect.
    Distinguish available, reserved, pending, and settled amounts.
    Do not expose owner-wide account information unless explicitly authorized.
    Never treat a displayed balance as a guarantee that a future payment will succeed.

4.2 payment.get_spending_policy

Purpose: Retrieve the effective spending policy for the current agent.

Parameters:

    allowance_id
    include_remaining_budget
    include_category_limits

Rules:

    Return the effective limits and permitted categories.
    Do not reveal secrets, payment credentials, internal fraud signals, or sensitive risk-model details.
    Report restrictions and approval requirements clearly.

4.3 payment.request_payment

Purpose: Request payment for an authorized good or service.

Required parameters:

    amount
    currency
    recipient_id
    description
    purpose_code
    idempotency_key

Optional parameters:

    allowance_id
    merchant_reference
    purchase_reference
    metadata

Rules:

    Validate amount, currency, recipient, and purchase purpose.
    Evaluate authorization, spending limits, recipient eligibility, and risk.
    Reserve funds before execution.
    Return a payment status and durable payment_id.
    Require human approval when the effective policy demands it.
    Reject attempts to exceed any applicable limit.
    Never interpret an agent's claim that a payment is urgent as permission to bypass controls.

4.4 payment.create_allowance

Purpose: Create or configure an allowance using owner-authorized settings.

Parameters:

    owner_id
    agent_id
    funding_source_reference
    budget_amount
    currency
    period
    per_transaction_limit
    per_day_limit
    per_month_limit
    allowed_categories
    allowed_recipients
    expiration
    approval_policy

Rules:

    This skill must be owner-authorized or restricted to a trusted service acting on the owner's behalf.
    An agent must not increase its own allowance or change its own restrictions.
    Validate that the owner is authorized to use the selected funding source.
    Enforce provider and account-level funding constraints.
    Require renewed authorization for material increases in spending authority.
    Treat recurring allowances as separate from one-time seeds.

4.5 payment.update_allowance

Purpose: Modify an existing allowance.

Parameters:

    allowance_id
    requested_changes
    owner_authorization_reference

Rules:

    Agents may only make changes explicitly permitted by the owner.
    Changes that increase spending authority require appropriate authorization.
    Restrictive changes may be applied immediately when safely supported.
    Preserve a versioned history of all changes.
    Never silently expand recipient permissions, payment categories, or expiration dates.

4.6 payment.pause_agent

Purpose: Stop new payment activity for an agent.

Parameters:

    agent_id
    reason_code

Rules:

    A trusted owner or authorized control service must invoke this action.
    Pausing must block new payment authorizations.
    In-flight transactions must be reported separately.
    Record the actor and reason for the pause.

4.7 payment.revoke_authorization

Purpose: Permanently revoke or terminate an agent's payment authority.

Parameters:

    agent_id
    authorization_reference
    reason_code

Rules:

    Require appropriate owner or administrative authority.
    Invalidate the relevant permissions and credentials.
    Block new transactions immediately.
    Prevent automatic reactivation.
    Record the revocation and its effective time.

4.8 payment.get_transaction_status

Purpose: Retrieve the status of an existing transaction.

Parameters:

    payment_id
    include_provider_reference

Rules:

    Enforce transaction-level access controls.
    Return only fields appropriate to the caller's permissions.
    Distinguish authorization, pending execution, success, failure, cancellation, refund, and reversal states.
    Do not report success until the provider response supports that status.

4.9 payment.request_refund

Purpose: Request a refund or reversal where supported.

Parameters:

    payment_id
    amount
    currency
    reason_code
    idempotency_key

Rules:

    Refunds must be associated with an eligible original transaction.
    Refunds must not exceed the refundable amount.
    Require the necessary merchant, provider, or owner permissions.
    Refund requests must not be assumed to succeed merely because they were submitted.

4.10 payment.send_agent_payment

Purpose: Transfer funds to another agent through an approved payment or settlement mechanism.

Parameters:

    sender_agent_id
    recipient_agent_id
    amount
    currency
    purpose_code
    idempotency_key

Rules:

    Verify both agent identities and their eligibility.
    Require explicit permission for agent-to-agent transfers.
    Apply recipient restrictions, budget limits, and fraud checks.
    Prevent unauthorized circular transfers and transfer chains.
    Do not treat an agent identity as proof that its recipient is trustworthy.
    If the provider does not support the required transfer type, return an unsupported-operation result rather than simulating a successful payment.

4.11 payment.list_transactions

Purpose: Retrieve the agent's authorized transaction history.

Parameters:

    start_time
    end_time
    status
    limit
    cursor

Rules:

    Enforce owner, agent, and allowance scoping.
    Apply pagination and reasonable query limits.
    Redact sensitive payment information.
    Do not expose unrelated agents' or owners' transactions.

5. Seed and Allowance Parameters
5.1 Seeds

A seed is an initial, explicitly authorized funding allocation intended to give an agent limited payment capacity.

Required attributes:

    seed_id
    owner_id
    agent_id
    amount
    currency
    funding_source_reference
    authorized_at
    status
    expires_at
    policy_version

A seed must not automatically create unlimited recurring spending authority. Define whether it represents a funding allocation, a payment instrument authorization, or an actual transfer of funds; these are different financial operations and must be modeled separately.
5.2 Allowances

An allowance defines the scope within which an agent may spend.

Recommended schema:
Parameter	Purpose
allowance_id	Unique allowance identifier
agent_id	Authorized agent
owner_id	Authorizing owner
budget_amount	Maximum budget for the allowance period
currency	Budget currency
period	One-time, daily, weekly, or monthly
per_transaction_limit	Maximum individual transaction
per_day_limit	Aggregate daily spending limit
per_month_limit	Aggregate monthly spending limit
allowed_categories	Permitted purchase categories
blocked_categories	Prohibited purchase categories
allowed_recipients	Optional recipient allowlist
allowed_merchants	Optional merchant allowlist
requires_approval_above	Threshold requiring human approval
max_transactions_per_period	Transaction-count limit
expires_at	Authorization expiration
auto_renew	Whether renewal is permitted
status	Active, paused, expired, or revoked
version	Monotonically increasing policy version
5.3 Effective limit calculation

The maximum amount an agent can spend on a transaction must be the minimum of all applicable limits.

Conceptually:
text

effective_transaction_limit = min(
    allowance.per_transaction_limit,
    remaining_allowance_budget,
    remaining_daily_budget,
    remaining_monthly_budget,
    remaining_category_budget,
    provider_transaction_limit,
    owner_account_limit
)

All amounts must be normalized to the applicable currency before comparison. Currency conversion must use an approved rate source and an explicit policy for fees, rounding, and exchange-rate changes.

If a limit is missing, undefined, or cannot be verified, do not interpret it as unlimited.

A transaction is eligible for execution only if:
text

agent_is_active
AND authorization_is_valid
AND allowance_is_active
AND recipient_is_permitted
AND category_is_permitted
AND amount_is_valid
AND amount <= effective_transaction_limit
AND sufficient_budget_is_available
AND risk_checks_pass
AND approval_requirements_are_satisfied

Provider constraints and applicable legal, compliance, and account restrictions must also be satisfied.
6. Payment Policy Engine

Implement a deterministic policy decision engine independent of the AI model.
Policy decision outputs

Every evaluation should return a structured decision:
json

{
  "decision": "allow",
  "reason_codes": [],
  "requires_human_approval": false,
  "policy_version": "1",
  "reservation_required": true,
  "decision_id": "decision_reference"
}

Supported decisions:

    allow — the operation is authorized and may proceed.
    deny — the operation violates policy or lacks authority.
    require_approval — the operation requires additional authorized human approval.
    defer — the system cannot safely determine the outcome yet.

The example policy version and identifiers are placeholders, not production values.
Evaluation order

    Authenticate the caller.
    Verify the agent's identity and status.
    Verify owner authorization and the relevant funding relationship.
    Validate the operation and request schema.
    Load the current policy and allowance version.
    Verify recipient, merchant, and category eligibility.
    Check per-transaction and aggregate limits.
    Check available budget and outstanding reservations.
    Evaluate risk, velocity, and abuse controls.
    Determine whether human approval is required.
    Return a decision with auditable reason codes.
    Revalidate critical conditions before committing payment execution.

A language model may propose an action, but it must not determine its own authorization outcome.
7. Mandatory Safeguards
7.1 Authorization and privilege boundaries

    Enforce owner-level and agent-level access controls on every request.
    Require explicit permission for every money-moving skill.
    Separate read-only skills from payment execution skills.
    Prevent agents from changing their own policies, credentials, or permissions.
    Require strong owner authentication and appropriate confirmation for sensitive permission changes.
    Do not expose provider credentials or unrestricted payment tokens to the model.

7.2 Spending controls

    Enforce transaction, daily, monthly, category, and allowance limits.
    Count pending reservations against available budgets.
    Use atomic reservations or equivalent concurrency-safe accounting.
    Prevent parallel requests from overspending a shared allowance.
    Apply transaction-count and velocity limits.
    Revalidate the effective policy immediately before execution.
    Do not let failed, pending, or timed-out requests release reservations prematurely when a payment may still have executed.

7.3 Human approval

Require an explicit, authenticated approval when the policy specifies it, including for:

    Transactions exceeding configured thresholds.
    New or untrusted recipients.
    High-risk or unusual purchase categories.
    Allowance increases or permission expansions.
    Agent-to-agent transfers where approval is required.
    Changes to funding sources or recurring payment authority.
    Transactions that trigger a risk or anomaly rule.

Approval must be bound to the transaction details, including amount, currency, recipient, purpose, and policy version. Material changes invalidate the approval and require reevaluation.
7.4 Fraud and abuse prevention

    Detect unusual transaction frequency and spending patterns.
    Detect repeated small payments that appear designed to evade limits.
    Flag circular transfers and suspicious chains of agent-to-agent payments.
    Maintain recipient and merchant risk checks.
    Apply configurable velocity limits and cooldown periods.
    Support transaction holds and owner notifications.
    Avoid relying exclusively on AI-generated explanations or declared purchase purposes.

7.5 Prompt injection and untrusted inputs

Treat all external content as untrusted, including:

    Merchant descriptions and web pages.
    Emails, documents, and retrieved content.
    Agent-to-agent messages.
    Tool responses and third-party API results.
    User-provided instructions that conflict with the authorization policy.

Instructions found in external content must never grant payment authority. The policy engine must validate the actual transaction independently of the model's reasoning.
7.6 Secrets and credential security

    Store credentials in an approved secret-management system.
    Encrypt sensitive data in transit and at rest.
    Use short-lived credentials and least-privilege scopes wherever supported.
    Redact payment credentials and sensitive personal information from logs.
    Rotate credentials according to security policy.
    Never expose secrets to agent prompts, skill outputs, or ordinary audit records.

7.7 Fail-safe behavior

Fail closed for authorization and spending decisions.

If the policy engine, owner authorization service, budget ledger, recipient validation service, or required risk check is unavailable, do not initiate a new payment unless an explicitly approved, narrowly scoped fallback policy allows it.

A provider timeout is not proof of failure. Reconcile the transaction before retrying with a new payment identifier.
8. Idempotency, Concurrency, and Transaction Integrity

Financial operations must be safe under retries, duplicate requests, concurrent agents, and partial system failures.
Idempotency requirements

Every money-moving request must include an idempotency key.

The server must:

    Associate the key with the authenticated owner, agent, operation, and canonical request payload.
    Return the original operation result for an identical retry.
    Reject reuse of the same key with materially different transaction details.
    Persist idempotency records for a period appropriate to provider and business requirements.
    Reconcile ambiguous provider outcomes before creating a replacement payment.

Budget reservation

Use a transactional ledger or equivalent strongly consistent accounting mechanism.

Conceptual flow:
text

BEGIN TRANSACTION

  Validate authorization and policy version
  Lock or atomically update the applicable budget
  Verify available balance and spending limits
  Create budget reservation
  Create durable payment intent
  Record audit event

COMMIT

Submit payment through the approved provider integration
Reconcile the provider outcome
Finalize or release reservation according to actual state

Do not hold a database transaction open while waiting for a network call to an external payment provider.

Use a durable job or transactional outbox pattern to coordinate execution. Design for crashes between submission and result recording.
Payment state machine

Recommended states:
text

CREATED
  -> VALIDATING
  -> AWAITING_APPROVAL
  -> RESERVED
  -> SUBMITTED
  -> PENDING_PROVIDER
  -> SUCCEEDED

Additional outcomes:
text

DENIED
FAILED
CANCELLED
EXPIRED
REQUIRES_RECONCILIATION
REFUND_PENDING
REFUNDED
REVERSED

Not every provider supports every state or transition. Map provider-specific statuses into the internal state model without inventing outcomes.

A timeout after submission should normally lead to reconciliation or a pending state, not an automatic assumption of failure.
9. API and Skill Contract

Every skill should use a versioned contract and return a consistent response structure.
Example
Create smoother payment processes.