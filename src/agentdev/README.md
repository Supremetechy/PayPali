# Agent Development (`src/agentdev`)

Every developed agent keeps five concerns separate, and none of them lives in model weights:

| Concern | Lives in | Written by |
|---|---|---|
| **Knowledge** (facts) | `KnowledgeModule` / `KnowledgeFact` | Owner (agents can only *propose*) |
| **Procedures** | `SkillDefinition` (versioned steps + required capabilities + risk) | Owner |
| **Built capability** (tool access) | `CapabilityGrant` (max risk, expiry, revocable) | Owner |
| **Behavior** | `AgentMemory` (`BEHAVIOR`/`PREFERENCE` from the owner, `LESSON` from background passes) | Owner and passes, never the agent |
| **Safety** | `AgentScore` / `ScoreStake`, backed by wallet bonds | Score gate |

`AgentDevService.context(agentId, {query})` is what a runtime puts in front of the model. It contains the score, the rules, the granted capabilities, the bound skills, the scoped facts with their sources, and the memory.

## The Score: a consequence before every action

1. **Quote** (`POST /api/agentdev/agents/:id/quote`). This is read-only. It returns `allowed`, the `reasons` for any refusal, the risk class, the attempt number, and the exact `onSuccess` and `onFailure` point deltas. It also returns the bond in money.
2. **Commit.** This locks the worst-case points **and** places a real wallet hold of `bondMinorPerPoint × lockedPoints`. Only then does the action run.
3. **Settle.** The outcome is binary and settles exactly once. A win releases the whole bond and pays a calibration reward. A loss burns points and forfeits the same share of the bond to the **Score Pool** account (ledger type `SCORE_FORFEIT`). If the result is ambiguous, the stake stays open until reconciliation (`POST /api/agentdev/stakes/:id/settle`). If it is still open after its TTL it settles as `EXPIRED`, which counts as a loss.

The math lives in `scoring.ts`:

```
stake  = (RISK_BASE[risk] + $moved/10) × 2^(attempt-1)       LOW 10 · MEDIUM 40 · HIGH 120 · CRITICAL 300
fee    = ceil(stake/10)                                      always paid: acting costs something
delta  = round(4·stake·(Brier − 0.75)) − fee                 failure gains are clipped to 0
```

What this does:

- **Honesty pays.** The rule is a proper scoring rule, so overstating confidence loses points in expectation.
- **Hedging doesn't.** Declaring 50% loses the fee whatever happens.
- **Expected failure doesn't pay.** An action you expect to fail always loses points in expectation.
- **Retries get expensive.** Retrying the same `intentKey` doubles the stake each time, up to 3 attempts. A goal that already succeeded cannot be staked again.
- **Risk is not the agent's choice.** It is the maximum of the capability's inherent risk, the skill's risk, and a level set by the amount of money moved.
- **The kill switch.** Probation (score below 1.5× the floor) allows LOW-risk actions only. At or below the floor the score is SUSPENDED and the agent is set `isActive = false`, which stops all money movement.

## Background passes (`BackgroundPasses.runAll`, every `PAYPALI_PASS_INTERVAL_MS`)

- **Expire stakes**: open stakes past their deadline settle as losses.
- **Consolidate**: each agent's last 50 settled stakes become per-capability `LESSON` memories covering calibration gaps, retry habits, and the most common failure causes. This is where behavior gets tuned.
- **Score health**: statuses are recomputed and any SUSPENDED agent is deactivated.
- **Knowledge hygiene**: facts past their expiry are retired.

## HTTP (dev server; unauthenticated like the rest of the harness)

`POST /api/agentdev/agents/:id/develop` · `GET …/agents/:id/context?q=` · `POST …/agents/:id/quote` ·
`POST …/agents/:id/capabilities` · `POST …/agents/:id/capabilities/:cap/revoke` · `POST …/agents/:id/skills|modules|memory` ·
`POST …/agents/:id/facts/propose` · `POST /api/agentdev/modules` · `POST …/modules/:id/facts` · `POST …/facts/:id/approve|supersede|retire` ·
`POST /api/agentdev/skills` · `POST …/stakes/:id/settle` · `POST …/passes/run`

Scored money movement goes through `POST /api/agents/:id/scored/{pay|checkout|payout}`. The body is the live fields plus `intentKey`, `confidencePct`, and an optional `skillId`.

Configuration: `PAYPALI_BOND_MINOR_PER_POINT` (default `1`, so 1 point = $0.01) and `PAYPALI_PASS_INTERVAL_MS` (default `60000`).
