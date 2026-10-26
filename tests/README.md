# Worker test harness

Exercises `PaymentOutboxWorker` against **real Postgres semantics** without a
server or Docker: [PGlite](https://github.com/electric-sql/pglite) (Postgres 16
compiled to WASM) runs in-process, driven through a Prisma driver adapter.

```bash
npm install          # approve the deferred install scripts if prompted:
                     #   npm install-scripts approve @prisma/client @prisma/engines esbuild prisma
npm test             # pretest regenerates the client + schema DDL, then runs vitest
npm run test:watch   # watch mode
```

## How it fits together

- `scripts/gen-schema-sql.mjs` runs `prisma migrate diff --from-empty
  --to-schema-datamodel` to derive the full DDL straight from `schema.prisma`
  into `tests/.generated/schema.sql`. (The committed migration is incremental —
  it `ALTER`s a pre-existing `PaymentIntent` — so it can't build from empty.)
- `harness.ts` boots a fresh PGlite DB per test, `exec`s that DDL, wires a
  `PrismaClient` over `pglite-prisma-adapter`, and provides a programmable
  `FakeBraintreeProvider` plus seed helpers.
- No real network, no credentials, no shared state between tests.

## What's covered

| Test | Path |
| --- | --- |
| happy path | `RESERVED → charge SUCCESS → SETTLED`, reservation `COMMITTED` |
| definitive decline | `charge DECLINED → FAILED`, reservation `RELEASED` |
| ambiguous then reconcile | thrown charge → `AMBIGUOUS` + `RECONCILE` event → `reconcile` SUCCESS → `SETTLED`, never re-charged |
| **reclaimed SUBMITTING** | stale `PROCESSING`/`SUBMITTING` lease is reclaimed → routed to reconcile, `charge` **never** called |
| **pre-dispatch recheck** | agent flipped inactive between `markSubmitting` and dispatch → cancelled before any provider call |
| markSubmitting gate | agent inactive up front → cancelled at the transition |
| settlement integrity | provider amount ≠ intent amount → reconcile instead of settling |

The two bolded rows are the recovery changes from the review: SUBMITTING-reclaim
reconciles first, and authorization is re-checked immediately before dispatch.

## Notes

- Requires a one-time native-binary fetch (Prisma query engine, esbuild) during
  `npm install`; npm defers those scripts until approved (see above).
- `harness.ts` casts the adapter at the `PrismaClient` seam: `pglite-prisma-adapter@0.6.x`
  bundles its own `@prisma/driver-adapter-utils` major, nominally distinct from
  the client's. Shapes match and are verified at runtime by this suite.
