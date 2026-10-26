+------------------------------------+
                |       AI Agent / Tool Request      | (Untrusted)
                +-----------------+------------------+
                                  |
                                  v
+---------------------------------+----------------------------------+
|                    PAYPALI ORCHESTRATION LAYER                     |
|                                                                    |
|  1. Identity & AuthN/AuthZ     Verify Agent & Owner authority      |
|  2. Policy Engine (Independent) Minimum of all limits, whitelist,  |
|                                risk, human-in-the-loop triggers    |
|  3. Concurrency-Safe Ledger    Durable reservations against budget |
|                                (Two-phase commit / Outbox)         |
|  4. Execution & Reconciliation Network call outside DB tx;         |
|                                Idempotency key; Ambiguous timeout  |
|                                reconciliation                      |
|  5. Audit & Provenance         Append-only, attributable logs      |
+---------------------------------+----------------------------------+
                                  |
                                  v
                +-----------------+------------------+
                |    Payment Provider (e.g. PayPal)  |
                +------------------------------------+

Core Invariants to Enforce in Code:

    Model Independence: The policy engine executes strictly in deterministic runtime code. The AI model only creates PaymentRequest intents; it has zero access to payment credentials, tokens, or direct provider endpoints.

    Fail-Closed Policy: Any missing field, unrecognized category, absent budget, or stale policy version immediately evaluates to DENIED. An undefined limit evaluates to zero spendable capacity until explicitly bounded.

    Effective Limit Calculation:

            
    Available Limit=min⁡(AgentAllowance,OwnerCap,CategoryLimit,RemainingBudget)−PendingReservations
    Available Limit=min(AgentAllowance,OwnerCap,CategoryLimit,RemainingBudget)−PendingReservations

          

    Non-Blocking Provider Calls: Database transactions must never span an external HTTP call. We use:

        Phase A (Local DB): Create PaymentIntent in RESERVED status + deduct reservation from spendable balance. Commit transaction.

        Phase B (External Call): Dispatch HTTP call with deterministic idempotency key.

        Phase C (Local DB): Update status to SETTLED (or mark for RECONCILIATION if timed out / ambiguous).

    Human Approval Binding: Approvals hash and bind (intent_id, amount, currency, recipient_id, policy_version, timestamp). Any change invalidates the approval.

2. Implementation Roadmap
Milestone	Deliverables	Focus
Milestone 1: Domain Models & Ledger	State machines, database schemas, reservation ledger, concurrency locks	Data integrity, double-spend prevention
Milestone 2: Policy & Decision Engine	Multi-tier limit evaluator, recipient validation, human-approval check	Deterministic authorization, fail-closed rule engine
Milestone 3: Intent Orchestrator & Outbox	State machine transitions, idempotency manager, outbox worker	Decoupling provider calls from DB transactions
Milestone 4: Provider Adapter & Reconciliation	Provider client interface, sandbox implementation, ambiguous timeout recovery	Strict provider compliance & error classification
Milestone 5: Agent Tool & Owner Control API	Sanitized Agent Tool interface, owner policy/allowance management, audit trail	Prompt injection defense, credential isolation
3. Step 1: Defining the Project Environment

Before writing code, let's establish the technical stack:

    Language & Runtime:

        Recommended: TypeScript (Node.js) or Python (FastAPI / Pydantic).

        TypeScript is standard for agent ecosystems (Model Context Protocol / LangChain / LangGraph) and provides end-to-end type safety.

        Python is equally strong if the agent pipeline is Python-native.

    Persistence:

        PostgreSQL (or SQLite with WAL mode for local dev/testing) to enforce atomic constraints (SELECT ... FOR UPDATE, check constraints, transactional outbox).

    Audit Ledger:

        Immutable append-only event table for all balance changes and policy evaluations.


To begin Milestone 1, please specify:
1. Architectural Distinction: Provider vs. Internal Database

Per the specification:

    Braintree GraphQL API is the Payment Provider (an external payment gateway owned by PayPal). It provides mutations such as chargePaymentMethod, authorizePaymentMethod, and transaction queries with idempotency keys.

    However, Braintree GraphQL cannot function as the internal state database. To satisfy the core invariants:

        “Count pending reservations against spendable budgets and make reservations concurrency-safe.”

        “Do not hold a database transaction open during a provider network call.”

        “Preserve versioned policy changes and attributable audit records.”

        “A timeout after submission is ambiguous: reconcile it rather than assuming failure.”

PayPali requires an internal operational datastore (e.g., PostgreSQL or SQLite) to manage:

    Agent identities, owner authorization, and versioned policies.

    Spendable budgets, allowances, and concurrency-safe balance reservations.

    Durable payment intents, an execution outbox, and audit ledgers.

Proposed Solution:

    Payment Provider: Braintree GraphQL API.

    Internal Datastore: PostgreSQL (or SQLite for single-node local development) using a type-safe SQL toolkit (e.g., Drizzle ORM or Kysely).

2. Milestone 1: Core Domain Models & State Machine (TypeScript)

Let’s establish the foundational types and state machine adhering strictly to the fail-closed, multi-tier limit, and two-phase reservation rules.
A. Payment Intent State Machine

[ CREATED ]
    │
    ▼
[ EVALUATING_POLICY ] ──(Policy Violation / No Budget)──► [ REJECTED ]
    │
    ▼
[ RESERVED ]  <--- Concurrency-safe budget lock in local DB
    │
    ├─(Requires Human Approval)──► [ PENDING_APPROVAL ] ──(Denied)──► [ CANCELLED ]
    │                                     │ (Approved)
    │ ◄───────────────────────────────────┘
    ▼
[ SUBMITTING ] <--- Outbox worker initiates call outside DB transaction
    │
    ├──(Success)─────────────────────────────────────────────► [ SETTLED ]
    ├──(Definitive Decline / 4xx)────────────────────────────► [ FAILED ] (Releases reservation)
    └──(Timeout / Network 5xx / Ambiguous)───────────────────► [ AMBIGUOUS_PENDING_RECONCILIATION ]
                                                                      │
                                                                      ├──(Reconciled Success)──► [ SETTLED ]
                                                                      └──(Reconciled Void)───► [ FAILED ]

                                                Key Protections Enforced Here:

    Row Lock Isolation (SELECT ... FOR UPDATE): Eliminates race conditions if multiple concurrent tool calls attempt to spend from the same agent’s allowance simultaneously.

    Pending Reservations Count Against Spendable Capacity: Active reservations immediately lower remaining capacity before any external network call.

    Database Transaction Decoupled from Provider Call: The reservation transaction commits before Braintree GraphQL is ever called. If Braintree hangs, no database locks or connections are held open.

    GraphQL query/mutation documents (chargePaymentMethod).

Deterministic idempotency key dispatch.

Ambiguous timeout handling and transaction reconciliation logic.

Integration Invariant Verification
Invariant	Implementation Mechanism
Idempotency	Injected as both HTTP header Idempotency-Key and GraphQL variable clientMutationId[3][4].
Timeout Safety	Catch block catches AbortError, ECONNRESET, ETIMEDOUT, and 5xx errors, mapping them to AMBIGUOUS. Budget is not released, and intent is not failed.
Reconciliation	The reconcile method inspects Braintree's ledger by orderId (= intentId). If no record exists, it safely resolves to DECLINED; if confirmed, it transitions to SUCCESS.
Direct Agent Disconnection	The AI agent invokes the high-level orchestration service; credentials (publicKey, privateKey) are isolated within this provider class.