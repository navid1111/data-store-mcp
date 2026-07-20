# data-store-mcp — Execution Plan

> Companion to [spec.md](spec.md) (*what* and *why*) and [architecture.md](architecture.md) (*how*).
> This document is the ordered task list.
>
> **Scope:** PostgreSQL, MySQL, MongoDB. SQL Server deferred.
> Task IDs are stable; `Spec` column links each task to the requirement it satisfies.

---

## Sequencing rationale

Four constraints determine the order, and they are worth stating because the intuitive
order (build the semantic layer first — it's the interesting part) is wrong.

1. **Governance precedes modeling.** `query_database` currently runs agent-authored SQL
   with no read-only guard, no limit, no timeout ([query.ts:65](src/mcp/tools/query.ts#L65)).
   Building features on top of that widens an open hole.
2. **Introspection precedes the semantic layer.** `mdl bootstrap` cannot work until
   `getSchema` returns a uniform shape with keys and comments (spec B7–B9).
3. **Evaluation precedes tuning.** Memory and prompt shaping are accuracy claims; without
   the golden eval there is no way to tell improvement from regression.
4. **Access control precedes nothing** — but it depends on the principal model and on the
   compiler existing, so it lands late.

---

## Phase 0 — Foundation

**Goal:** make the codebase modelable and testable. No user-visible features.

Ordered by dependency. IDs are stable and referenced by [test.md](test.md); the ordering
column is what to work through.

| # | ID | Task | Spec | Depends | Status |
|---|---|---|---|---|---|
| 1 | 0.1 | Vitest harness + CI (typecheck, build, test) on push | B6 | — | **done** |
| 2 | 0.8 | Integration tests per source against Pagila / Sakila / seeded Mongo | B6 | 0.1 | **done** |
| 3 | 0.10 | E2E test driving the real MCP server over stdio | B6 | 0.8 | **done** |
| 4 | 0.3 | Fix identifier injection in `getSchema` — Postgres `WHERE table_name = '...'`, MySQL `DESCRIBE ...` | B10 | 0.8 | **done** |
| 5 | 0.11 | Return tool execution failures as `isError` results instead of throwing | B14, R2.2 | 0.10 | **done** |
| 6 | 0.2 | Type `ConnectionConfig.options` per source; drop `any` | B5 | — | **done** |
| 7 | 0.4 | Define `ColumnInfo`, `TableInfo`, `ColumnProfile` in `sources/types.ts` | §5.1 | 0.2 | **done** |
| 8 | 0.9 | Fix `MysqlDatabase.getRelations` signature — declares `databaseName` required, base declares optional | B12 | 0.4 | **done** |
| 9 | 0.5 | Add `listTables()`; make `getSchema` return `ColumnInfo[]` uniformly across all three adapters | B7, B9, B13 | 0.4 | **done** |
| 10 | 0.6 | Extend introspection: PK, unique, defaults, **DB comments** | B8, §5.1 | 0.5 | **done** |
| 11 | 0.7 | Implement `profile()` for Postgres + MySQL | R3.8 | 0.5 | **done** |

Every task above has an explicit pass/fail specification in [test.md](test.md), keyed by
the same ID.

### Fixture environment *(0.1 / 0.8, complete)*

```
./scripts/fetch-fixtures.sh   # Pagila + Sakila dumps -> fixtures/ (gitignored)
npm run db:up                 # compose up, waits for data to actually be loaded
npm run build                 # e2e suite spawns dist/server.js
npm test                      # 208 passing, 3 skipped, 2 todo
```

Two layers of coverage, and the distinction matters: `tests/integration/` drives the
adapter classes directly, while `tests/e2e/` spawns the real MCP server over stdio and
drives the published tools. The adapter tests bypass the registry, the zod schemas, the
`ConnectionManager` and the response envelope entirely — B14 was only visible from e2e.

Postgres/Pagila on `55432`, MySQL/Sakila on `53306`, Mongo on `57017`. Data lives in
tmpfs, so `npm run db:reset` gives a clean seed.

Two things worth knowing about the fixtures:

- **`POSTGRES_USER` must be `postgres`.** `pagila-schema.sql` contains hardcoded
  `ALTER ... OWNER TO postgres`; any other role makes the whole init script fail.
- **Healthchecks query `film`, not `pg_isready`/`mysqladmin ping`.** Both entrypoints run
  init scripts against a temporary local server before opening the real port, so a
  liveness probe goes green while 3.2 MB of data is still loading.
- **Mongo is seeded programmatically** (`tests/helpers/seed-mongo.ts`) — there is no
  canonical document-store equivalent of Pagila. It is deliberately denormalized, which
  is itself the argument for spec D2.

The suite encodes each known gap as a passing `GAP` test asserting current behaviour,
paired with an `it.todo` for the target state. So the 5 todos are the Phase 0 checklist,
and the GAP tests will fail loudly when the fix lands — which is the signal to delete
them.

**Done when:** all three adapters return an identical `getSchema` shape including PKs and
comments, `profile()` returns top-N values for a low-cardinality column, and CI is green.

**Phase 0 complete.** 208 tests passing. Remaining GAP tests are `GAP B1` (SQL Server
deferred by design) and `GAP B2` (unbounded query — closed by Phase 1), plus two
`it.todo`s that belong to tasks 1.3 and 1.5.

**Note:** 0.3 turned out to be more than the "one-line fix" originally estimated — MySQL's
`DESCRIBE` takes an identifier, which cannot be bound as a parameter, so it needed a
validator (`src/identifiers.ts`) rather than parameterization.

---

## Phase 1 — Governance

**Goal:** the security floor. After this phase, no agent can run a destructive or
unbounded query, and no credential passes through the model.

| ID | Task | Spec | Depends |
|---|---|---|---|
| 1.1 | Add `node-sql-parser`; `governance/parse.ts` (SQL → AST, per-dialect) | R2.1 | 0.1 **done** |
| 1.2 | Structured error taxonomy `governance/errors.ts` | R2.2 | — **done** |
| 1.3 | Read-only assertion: reject non-`SELECT` roots + multi-statement payloads | R1.2 | 1.1 **done** |
| 1.4 | Branded `QueryPlan` type; `execute(plan)` replaces `query(sql)` on adapters | arch §5 | 0.4 **done** |
| 1.5 | Limit injection into AST (respect smaller user limit); hard server ceiling | R1.1 | 1.1, 1.4 **done** |
| 1.6 | Timeout with real driver-level cancellation | R1.3 | 1.4 **done** |
| 1.7 | Parameter binding — literals bound, never interpolated | R8.6 | 1.1 **done** |
| 1.8 | Mongo gate: read-only ops, forced `$limit`, pipeline-stage cap | R1.6 | 1.4 **done** |
| 1.9 | Config-driven source registry; **delete `connect_database`** | R8.1, R8.2, B4 | 0.2 **done** |
| 1.10 | Byte cap on result sets | R1.4 | 1.4 **done** |
| 1.11 | Audit log (append-only, one record per execution incl. failures) | R8.5 | 1.4 **done** |

**Done when:** `DROP TABLE users` and `SELECT * FROM events` are both refused with
structured errors; no credential appears in any MCP argument or response; every execution
produces an audit record.

**Invariant tests to write here** (architecture §7): no tool→driver path accepts a string;
only `governance/` constructs a `QueryPlan`.

---

## Phase 2 — Semantic layer + dry-plan

**Goal:** the differentiator. Agents query business concepts, and wrong guesses fail
loudly with hints.

| ID | Task | Spec | Depends |
|---|---|---|---|
| 2.1 | MDL types + YAML schema: model, column, relationship, metric, view, cube | R3.2 | — **done** |
| 2.2 | `semantic/registry.ts` — load, validate, index MDL; `provenance`/`verified` fields | R3.1, R3.6 | 2.1 **done** |
| 2.3 | Join-path resolution over the relationship graph | R3.4 | 2.2 |
| 2.4 | MDL → SQL compiler, Postgres + MySQL dialects | R3.4, R2.3 | 2.3, 1.5 |
| 2.5 | Identifier resolution against registry + `did_you_mean` via edit distance | R2.2 | 2.2, 1.2 |
| 2.6 | `dry_plan` tool — validate, return plan metadata, no execution | R2.1, R2.4 | 2.5 |
| 2.7 | Tool surface rework: `list_sources`, `describe_model`, `list_metrics`, `query` | R6.1 | 2.2 |
| 2.8 | `mdl bootstrap`: introspect + profile → draft YAML, all `verified: false` | R3.7, §5.4 | 0.6, 0.7, 2.2 |
| 2.9 | LLM drafting of descriptions/metrics inside bootstrap | R3.7, §5.3 | 2.8 |
| 2.10 | Artifact mining: `pg_stat_statements` / slow log → join patterns, filters, aggregates | R3.10, §5.3 | 2.8 |
| 2.11 | Relationship inference where FKs are undeclared (name → type → value overlap) | R3.9, B11 | 0.7, 2.8 |
| 2.12 | `mdl lint` — drift between MDL and live DB | R3.5 | 2.2 |
| 2.13 | `instructions.md` + `queries.yml` loading | R4.1, R4.2 | 2.2 |
| 2.14 | Description coverage rule: undescribed model = lint error | R3.3 | 2.12 |

**Done when:** an agent answers a business question through a metric it did not have to
infer; a hallucinated column returns `did_you_mean`; bootstrapped entities are marked
unverified and `dry_plan` says so.

**Largest unknown:** 2.4 (two dialects, no normalization layer — see architecture §9) and
2.10 (query-log formats differ per source). Timebox 2.10; it is high-value but skippable
if it turns into a project of its own.

---

## Phase 3 — Memory, CLI, evaluation

**Goal:** measurable accuracy, and a human-usable surface.

| ID | Task | Spec | Depends |
|---|---|---|---|
| 3.1 | Golden eval runner over `queries.yml`; pass-rate report | R7.1 | 2.13 |
| 3.2 | Eval in CI on every MDL change | R7.3 | 3.1 |
| 3.3 | LanceDB index of successful executions | R5.1 | 1.11 |
| 3.4 | Hybrid retrieval: BM25 + vector, reciprocal rank fusion | R5.2 | 3.3 |
| 3.5 | `search_context` tool; precedents labeled as prior art, not truth | R5.3, R6.1 | 3.4 |
| 3.6 | Promote approved queries into `queries.yml` | R5.4 | 3.5 |
| 3.7 | CLI: `serve`, `mdl lint`, `mdl bootstrap`, `query --sql` | R6.2 | 2.12 |
| 3.8 | `ask` with `--guided` / `--direct` context assembly | R6.4 | 3.4, 3.7 |
| 3.9 | Guided-vs-direct accuracy benchmark on the golden set | R7.2 | 3.1, 3.8 |
| 3.10 | `skills get` / `skills add` workflow guides | R6.3 | 3.7 |

**Done when:** the golden eval reports a pass rate and 3.9 shows a measurable delta
between guided and direct.

**Do 3.1 before 3.3.** Building memory before the eval means tuning retrieval with no
feedback signal.

---

## Phase 4 — Access control + Mongo modeling

| ID | Task | Spec | Depends |
|---|---|---|---|
| 4.1 | Principal model: startup config (stdio) / per-request (HTTP) | D3 | 1.9 |
| 4.2 | Policy engine: principal → RLAC predicates, CLAC column sets | R8.3 | 4.1, 2.2 |
| 4.3 | RLAC predicate injection post-parse (non-bypassable) | R8.3 | 4.2, 1.5 |
| 4.4 | CLAC: hidden columns omitted from `describe_model` entirely | R8.4 | 4.2, 2.7 |
| 4.5 | Policy decisions recorded in audit | R8.5 | 4.3, 1.11 |
| 4.6 | Mongo → MDL mapping (collection → model, `$lookup` → relationship) | D2 | 2.2 |

**Done when:** two principals run the same question and correctly get different rows, and
a CLAC-hidden column is absent from `describe_model` output.

---

## Phase 5 — Dashboards *(only on real demand)*

| ID | Task | Spec |
|---|---|---|
| 5.1 | Self-contained HTML+JS dashboard generation from metrics | R9.1 |
| 5.2 | Deploy to Vercel / Cloudflare Pages | R9.3 |
| 5.3 | **Human confirmation required per deploy** — never autonomous | R9.4 |

Do not start this phase to make the project look finished. 5.3 is non-negotiable if 5.2
ships: deployment publishes data to the public internet.

---

## Milestones

| M | Name | Phases | Meaning |
|---|---|---|---|
| M1 | Safe | 0 + 1 | Nothing an agent does can damage or exfiltrate at scale |
| M2 | Smart | 2 | The agent stops guessing schema |
| M3 | Measurable | 3 | Accuracy claims are testable |
| M4 | Governed | 4 | Multi-user, policy-enforced, auditable |

M1 is shippable on its own and is a genuine improvement over today. M2 is the point at
which the project is meaningfully WrenAI-shaped.

---

## Start here

If you do nothing else this week:

1. **0.3** — the Postgres `getSchema` injection, one line.
2. **0.1** — Vitest + CI, so everything after is verifiable.
3. **1.1 + 1.3 + 1.5** — parser, read-only guard, limit injection. This is the smallest
   set that closes the open hole in `query_database`.

That is M1's core in roughly a week, and it is the only work whose absence is actively
dangerous.

---

## Open questions blocking work

Carried from [spec.md](spec.md) §8, annotated with what they block:

1. **Principal source** — env var vs `express_server.ts` as the multi-user path.
   *Blocks 4.1;* if HTTP is the real target, 4.1 should move into Phase 2.
2. **Metric semantics** — pre-aggregated or always live SQL? *Blocks 2.4 caching design.*
3. **Mongo in MDL** — if Mongo stays exploratory, 4.6 disappears.
4. ~~Dialect breadth~~ — **resolved:** two dialects (Postgres, MySQL) with SQL Server
   deferred.
