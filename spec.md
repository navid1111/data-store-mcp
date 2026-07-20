# data-store-mcp — Specification

> Target: a WrenAI-shaped semantic layer + governed execution engine for AI agents,
> scoped to the four data sources this project already supports.
> Status: draft. Phases 1–2 are committed; 3+ are directional.

---

## 1. Goal

Turn `data-store-mcp` from a thin "connect and run SQL" MCP server into a **governed
semantic layer**: agents ask questions against modeled business concepts, not raw
tables, and every execution is bounded, validated, and auditable.

The value proposition is not "an LLM can reach my database" — it already can. It is:

1. The agent is given **ground truth** (semantic model) instead of guessing schema.
2. The agent **cannot** run an unbounded or destructive query, even if it tries.
3. A wrong query fails **loudly and structurally**, with hints, instead of returning
   confidently wrong rows.

### Non-goals

- **Not** 22+ data sources. Scope is PostgreSQL, MySQL, MongoDB. **SQL Server is
  deferred** — `src/mssql.ts` stays in the tree, unwired, and is not a Phase 0 task.
  This reduces the Phase 2 compiler to two SQL dialects.
- **Not** a hosted product. No multi-tenant SaaS, no billing, no web UI beyond
  generated dashboards.
- **Not** an LLM provider. This project supplies context and enforces boundaries;
  the calling agent owns the model.

---

## 2. Current state (baseline)

634 lines of TypeScript. MCP server over stdio ([src/server.ts](src/server.ts)) plus an
Express variant ([src/express_server.ts](src/express_server.ts)).

**Abstraction** — [`Database`](src/database-source.ts#L29) abstract class with four
members: `connect`, `query`, `getSchema`, `getRelations`. Implemented by
`PostgresDatabase`, `MysqlDatabase`, `MssqlDatabase`, `MongoDatabase`.

**MCP tools** — four, registered in [src/mcp/tools/index.ts](src/mcp/tools/index.ts):
`echo`, `connect_database`, `query_database`, `inspect_database`.

**Known gaps in the baseline** (all must be closed before or during Phase 1):

| # | Gap | Location |
|---|---|---|
| B1 | `MssqlDatabase` is implemented but not constructible — `connect_database` enum omits it. **Deferred**: SQL Server is out of current scope, so this stays as-is | [connect.ts:17](src/mcp/tools/connect.ts#L17), [connect.ts:87-93](src/mcp/tools/connect.ts#L87-L93) |
| B2 | Arbitrary SQL executed with no row limit, no read-only guard, no timeout | [query.ts:65](src/mcp/tools/query.ts#L65) |
| B3 | DB credentials are passed as plaintext MCP tool arguments, i.e. through the LLM context | [connect.ts:26-28](src/mcp/tools/connect.ts#L26-L28) |
| B4 | Connections live in an in-memory singleton; all state lost on restart | [connection-utils.ts:6](src/connection-utils.ts#L6) |
| B5 | `ConnectionConfig.options` is typed `any` | [database-source.ts:9](src/database-source.ts#L9) |
| B6 | No test harness (`npm test` is a stub) | [package.json](package.json) |
| B7 | `getSchema()` with no table omits `table_name`, so multi-table introspection returns columns that can't be attributed to a table | [postgres.ts:29](src/postgres.ts#L29) |
| B8 | `getSchema` returns no PK/unique/default/comment — insufficient to derive relationship cardinality or reuse documented descriptions | all adapters |
| B9 | `getSchema` contract differs per adapter: MSSQL returns *table names* with no arg and *columns* with one; Postgres returns columns either way | [mssql.ts:72-74](src/mssql.ts#L72-L74) vs [postgres.ts:27-35](src/postgres.ts#L27-L35) |
| B10 | `tableName` interpolated directly into SQL (injection). Postgres puts it in a `WHERE` literal; MySQL puts it in `DESCRIBE ${tableName}`, which cannot be parameterized at all and needs identifier quoting or an allowlist. Both are verified reachable by integration tests | [postgres.ts:32](src/postgres.ts#L32), [mysql.ts:30](src/mysql.ts#L30) |
| B11 | `getRelations` reads FK constraints only; databases with no declared FKs return an empty relationship graph | all SQL adapters |
| B12 | `MysqlDatabase.getRelations(databaseName: string)` declares the parameter required while the base class declares it optional — the subclass is not substitutable for `Database` | [mysql.ts:36](src/mysql.ts#L36) vs [database-source.ts:38](src/database-source.ts#L38) |
| B13 | MySQL `getSchema` returns `DESCRIBE` output (`Field`/`Type`/`Null`) while Postgres returns `column_name`/`data_type`/`is_nullable` — B9 is a shape divergence, not just an arity one | [mysql.ts:29-31](src/mysql.ts#L29-L31) |
| B14 | Tool handlers `throw`, so execution failures surface as JSON-RPC protocol errors (-32603) instead of a tool result with `isError: true`. A protocol error is not part of the model's tool-result stream, so the agent cannot read it and self-correct — R2.2 depends on the opposite | [server.ts:59-61](src/server.ts#L59-L61) |

B2, B3 and B10 are security-relevant and are the reason Phase 1 leads with governance
rather than with modeling. B7–B9 block §5 (semantic model acquisition) and must be closed
in Phase 0; B11 is addressed by relationship inference (R3.9) in Phase 2.

---

## 3. Architectural decisions

Three decisions determine most of the downstream work. Each states the choice and
the reasoning, because each has a defensible alternative.

### D1 — No Apache DataFusion. Validate in TypeScript, push execution down.

WrenAI's engine is Rust/DataFusion because it federates 22+ heterogeneous sources
and needs its own planner. Adopting it here would mean a `napi-rs` sidecar or a WASM
build, a second toolchain, and a cross-language build — for three sources that each
already have a perfectly good planner.

**Decision:** the semantic layer compiles MDL to SQL, validates it with a TypeScript
parser (`node-sql-parser`), and executes it **on the source database**. Governance is
enforced by AST rewriting before dispatch, not by owning the execution engine.

**Revisit when** cross-source joins become a real requirement. At that point adopt
**DuckDB** (mature Node bindings, `postgres_scan`/`mysql_scan` extensions, in-process)
rather than DataFusion — same federation benefit, no new language.

**Cost of this decision:** we do not get DataFusion's optimizer or its uniform SQL
dialect. Dialect differences between Postgres and MySQL must be handled explicitly
in the compiler (see R2.3).

### D2 — MongoDB is a first-class source but is excluded from the SQL semantic layer in Phase 1–2.

MDL, dry-plan validation, and SQL compilation are relational concepts. Mongo's
document model does not map cleanly onto models/columns/relationships, and
[query.ts:50-63](src/mcp/tools/query.ts#L50-L63) already treats it as a special case
with a wholly separate payload shape.

**Decision:** Mongo keeps working through the existing `query_database` path with
governance applied (R1.x), but is not modeled in MDL until Phase 4, which introduces
a document-source mapping (collection → model, `$lookup` → relationship).

Pretending Mongo is relational in Phase 1 would produce a leaky MDL that we'd have to
redesign later.

### D3 — Access control requires a principal. The caller supplies it; we never infer it.

RLAC/CLAC is meaningless without knowing *who is asking*. An MCP server invoked over
stdio has no inherent user identity, and identity must never be self-asserted by the
LLM — an agent that can set its own `role` can escalate by asking.

**Decision:** the principal is supplied out-of-band at **server startup** (env/config)
or by the **host application** in the Express deployment, never as an argument the
model can populate. Policies are evaluated against that principal server-side.

---

## 4. Requirements

Numbered for traceability. **MUST** = Phase 1–2 blocking. **SHOULD** = Phase 3+.

### R1 — Governed execution

- **R1.1 (MUST)** Every query is rewritten to carry a row limit before dispatch.
  Injected into the AST, not string-appended. Default 1000, configurable, hard ceiling
  enforced server-side. If the user's SQL already has a smaller `LIMIT`, keep theirs.
- **R1.2 (MUST)** Read-only enforcement. Reject any statement whose parsed AST root is
  not `SELECT` (or a read-only CTE). Blocks `INSERT`/`UPDATE`/`DELETE`/`DROP`/`ALTER`/
  `TRUNCATE`/`GRANT`, plus multi-statement payloads. Rejection is a structured error,
  never a silent no-op.
- **R1.3 (MUST)** Per-query timeout with real cancellation at the driver level, not a
  dangling promise. Default 30s.
- **R1.4 (SHOULD)** Result-size cap in bytes, independent of row count — one row with a
  50MB blob column must not reach the agent's context.
- **R1.5 (SHOULD)** Cost pre-check via `EXPLAIN` where the source supports it; refuse
  plans above a configured cost threshold.
- **R1.6 (MUST)** Mongo equivalents: forbid non-read operations, force a `$limit` stage,
  and cap `aggregate` pipeline stages.

### R2 — Dry-plan validation

- **R2.1 (MUST)** `dry_plan` validates without executing: parse → resolve identifiers
  against the semantic model → typecheck comparisons → return plan metadata.
- **R2.2 (MUST)** Errors are **structured and actionable**, never a raw driver string.
  Shape: `{ code, message, location: {line, column}, hint, did_you_mean[] }`.
  Returned as a tool **result** with `isError: true` — never thrown (B14), because a
  JSON-RPC protocol error never reaches the model as tool output and so cannot be
  corrected from.
  An unknown column returns the three nearest real columns by edit distance. This is
  the single highest-leverage anti-hallucination feature in the spec — it converts a
  wrong guess into a corrective signal the agent can act on in one turn.
- **R2.3 (MUST)** Dialect awareness. The validator knows whether it is targeting Postgres
  or MySQL and rejects constructs unsupported by that target.
- **R2.4 (SHOULD)** Every `query` implicitly dry-plans first; execution proceeds only
  on a clean plan.

### R3 — Semantic layer (MDL)

- **R3.1 (MUST)** MDL files are YAML on disk under `semantic/`, Git-tracked, and
  human-reviewable in a pull request.
- **R3.2 (MUST)** Entities: `model` (table/view + columns), `relationship`
  (one-to-many, many-to-one, many-to-many with join keys), `metric` (named aggregate
  expression), `view`, `cube` (dimensions + measures).
- **R3.3 (MUST)** Every model, column, and metric carries a `description`. Descriptions
  are what the agent actually reads — an undescribed model is a modeling bug, and the
  linter treats it as one.
- **R3.4 (MUST)** MDL → SQL compiler. Resolves a metric/dimension selection into
  dialect-correct SQL with correct join paths derived from declared relationships.
- **R3.5 (SHOULD)** `mdl lint` — validates MDL against the live database and flags
  drift: model references a dropped table, declared relationship has no matching FK,
  column type changed.
- **R3.6 (MUST)** Every MDL entity carries `provenance` and `verified` fields. Machine
  -generated content is `verified: false` and `dry_plan` warns when a query depends on
  an unverified model. See §5 for the full acquisition pipeline and the reasoning.
- **R3.7 (MUST)** `mdl bootstrap` — generate a first-draft MDL by introspection +
  profiling + artifact mining, per §5. All generated descriptions are unverified.
- **R3.8 (MUST)** Value profiling: per-column cardinality, null rate, min/max, and
  top-N distinct values for low-cardinality columns. Surfaced through `describe_model`
  so the agent can map a natural-language value ("California") to a stored one (`'CA'`).
- **R3.9 (SHOULD)** Relationship inference for sources with no declared FKs (B11):
  name-convention match → type compatibility → value-overlap sample. Emitted as
  candidates with `verified: false`, never as facts.
- **R3.10 (SHOULD)** Artifact mining from existing SQL — query logs, dbt models, ORM
  definitions, saved BI reports. See §5.3.

### R4 — Version-controlled context

- **R4.1 (MUST)** `instructions.md` — freeform business rules and definitions, loaded
  into agent context. Git-tracked.
- **R4.2 (MUST)** `queries.yml` — curated question → approved-SQL pairs. Doubles as the
  golden eval set (R7.1).
- **R4.3 (MUST)** No vendor UI or hidden prompt store. Everything the agent knows is a
  file in the repo, reviewable in a diff.
- **R4.4** Note: `.gitignore` previously ignored `*.md` wholesale; the exemptions for
  `spec.md`/`instructions.md`/`docs/` are load-bearing for R4.1. Do not remove them.

### R5 — Memory & hybrid retrieval

- **R5.1 (SHOULD)** Index successful executions (question, SQL, result shape, timing)
  in a local vector store. **LanceDB** unless its Node bindings prove unstable, in
  which case `sqlite-vec`.
- **R5.2 (SHOULD)** Hybrid retrieval: BM25 keyword + dense vector, fused via
  reciprocal rank fusion. Pure vector search reliably misses exact table-name matches.
- **R5.3 (SHOULD)** Retrieved precedents are injected as *examples*, clearly labeled as
  prior art rather than ground truth — a previously-successful query is not proof of
  correctness for the current question.
- **R5.4 (SHOULD)** Feedback loop: queries the user marks good are promoted into
  `queries.yml` (R4.2), making memory reviewable rather than an opaque cache.

### R6 — Agent integration & orchestration

- **R6.1 (MUST)** MCP tool surface, revised:
  `list_sources`, `describe_model`, `dry_plan`, `query`, `search_context`,
  `list_metrics`. The current `connect_database` is **removed** from the agent surface
  (see R8.2) — sources come from config, not from the model.
- **R6.2 (MUST)** CLI `data-store-mcp` (or `dsm`) with: `serve`, `mdl lint`,
  `mdl bootstrap`, `ask "<q>"`, `query --sql`, `skills get <name>`, `skills add`.
- **R6.3 (SHOULD)** `skills get <workflow>` serves structured markdown workflow guides
  (`onboarding`, `enrich-context`, `genbi`) directly to the agent.
- **R6.4 (SHOULD)** Shaped prompting: `ask --guided` assembles schema + semantic context
  + retrieved precedents into a single prompt; `--direct` passes through unshaped.
  The difference between the two is the measurable value of the semantic layer (R7.2).
- **R6.5 (SHOULD)** A Python SDK, if and only if a real consumer needs it. Do not build
  `wren-langchain`/`wren-pydantic` equivalents speculatively.

### R7 — Evaluation *(not in the original feature list; added — see §7)*

- **R7.1 (MUST)** Golden eval runner: execute every `queries.yml` pair, compare result
  sets against recorded expectations, report pass rate.
- **R7.2 (SHOULD)** Accuracy benchmark comparing `--guided` vs `--direct` on the golden
  set. Without this, "improves text-to-SQL accuracy" is an unfalsifiable claim.
- **R7.3 (SHOULD)** Eval runs in CI on every MDL change — the regression suite for the
  semantic layer.

### R8 — Security & access control

- **R8.1 (MUST)** Credentials move out of MCP tool arguments (baseline gap B3) into
  environment/config, referenced by source name. The LLM must never see a password.
- **R8.2 (MUST)** Sources are declared in config at startup, not opened on demand by
  the model. Closes B3 and B4 together.
- **R8.3 (SHOULD)** RLAC — row-level predicates declared per model in MDL, injected
  into the `WHERE` clause server-side during compilation. Non-bypassable: applied after
  the agent's SQL is parsed, so no agent-authored text can remove it.
- **R8.4 (SHOULD)** CLAC — column-level visibility per principal. Hidden columns are
  omitted from `describe_model` output entirely; an agent cannot request what it was
  never shown.
- **R8.5 (SHOULD)** Audit log: principal, question, compiled SQL, row count, duration,
  outcome — append-only, for every execution.
- **R8.6 (MUST)** Parameterized values only. Literals from agent input are bound as
  parameters, never interpolated.

### R9 — Dashboard generation *(lowest priority; see §6 Phase 5)*

- **R9.1 (SHOULD)** Generate a self-contained interactive dashboard (HTML + inlined JS)
  from a set of metrics.
- **R9.2 (COULD)** Browser-side execution via WASM. Requires D1 revisited — deferred.
- **R9.3 (COULD)** One-command deploy to Vercel / Cloudflare Pages.
- **R9.4 (MUST, if R9 is built at all)** Deployment publishes data to the public
  internet. It requires explicit human confirmation per deploy and must never be an
  autonomous agent action.

---

## 5. Acquiring the semantic model

The MDL is the core asset. How it gets populated determines whether the whole system is
trustworthy, so this is specified rather than left to R3.7.

Three tiers of information feed an MDL, with sharply different acquisition costs.

### 5.1 Tier 1 — Structure (free, from introspection)

Tables, columns, types, nullability, primary keys, uniqueness, defaults, foreign keys.

Requires closing B7–B9 first: today `getSchema` cannot attribute columns to tables in
the multi-table case, omits keys and defaults, and has a different contract per adapter.

Also read **database comments**, which nothing currently does: Postgres
`obj_description()` / `col_description()`, SQL Server `sys.extended_properties`
(`MS_Description`), MySQL `COLUMN_COMMENT`. Where a team has documented its schema in
the database, that is human-authored Tier 3 content available for free, and it should be
imported with `provenance: db_comment, verified: true`.

### 5.2 Tier 2 — Statistics (cheap, from profiling queries)

Row counts, distinct counts, null rates, min/max ranges, and top-N distinct values for
low-cardinality columns (R3.8).

Profiling also drives relationship inference where FKs are undeclared (R3.9, B11): match
by naming convention, filter by type compatibility, then confirm with a value-overlap
sample. Output is always a candidate for human confirmation.

### 5.3 Tier 3 — Meaning (not derivable; requires humans)

What "active customer" means. Why `status = 3` is cancelled. Which of two revenue columns
is authoritative. Whether `deleted_at IS NULL` is implied on every query against a table.

**None of this exists in the database.** An LLM can draft it from names and sample values,
and will produce fluent, plausible, unverifiable prose.

> A bootstrapped MDL full of invented descriptions is **worse than no MDL**. It converts a
> guess into apparent ground truth, which is the exact failure this project exists to
> prevent. Hence R3.6: generated content is `verified: false` until a human confirms it in
> a pull request. The review *is* the Tier 3 acquisition step, not a formality after it.

The highest-value Tier 3 source is **existing SQL** (R3.10): `pg_stat_statements`, the
MySQL slow log, SQL Server Query Store, plus dbt models, ORM definitions and saved BI
reports in the repo. Real queries encode real intent — join patterns reveal the true
relationship graph including undeclared FKs; repeated `WHERE` clauses reveal unwritten
business rules (if every analyst query filters `status != 'test'`, that is a semantic
rule); recurring aggregates are metric definitions already validated by use. Mining
historical SQL yields a better model than introspection and LLM drafting combined, and is
the step most bootstrap tools omit.

### 5.4 Pipeline

```
1. introspect  → tables, columns, types, PK/FK, DB comments        (5.1)
2. profile     → cardinality, null rates, ranges, top-N, FK cands  (5.2)
3. mine        → join patterns, filters, aggregates from real SQL  (5.3)
4. draft       → LLM proposes descriptions + metrics, unverified   (R3.6)
5. review      → human edits YAML, flips verified, in a PR         (5.3)
6. refine      → promote successful queries into queries.yml       (R5.4)
```

Steps 1–4 are `mdl bootstrap` and should be one command. Step 5 is the only step that
produces trustworthy Tier 3 content and is not skippable.

### 5.5 Provenance in MDL

```yaml
- name: orders
  description: Customer purchase orders, one row per checkout.
  provenance: llm_draft    # introspection | profiling | db_comment | query_log | llm_draft | human
  verified: false          # dry_plan warns when an unverified entity is used
```

---

## 6. Phased roadmap

Each phase is independently useful and shippable.

### Phase 0 — Foundation *(small, unblocks everything)*
Fix B5 (type `options` per source), B6 (test harness — Vitest), B10 (parameterize
`getSchema`). Add CI running typecheck + tests. B1 is deferred with SQL Server.

Then extend the `Database` interface, since §5 cannot be built on the current one:

```ts
interface ColumnInfo {
  table: string;          // fixes B7
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;  // fixes B8 — needed for relationship cardinality
  isUnique: boolean;
  defaultValue?: string;
  comment?: string;       // fixes B8 — free Tier 3 content (§5.1)
}

interface ColumnProfile {
  table: string;
  column: string;
  distinctCount: number;
  nullRate: number;
  min?: unknown;
  max?: unknown;
  topValues?: Array<{ value: unknown; count: number }>;  // R3.8
}

abstract class Database {
  abstract listTables(): Promise<TableInfo[]>;              // fixes B9 — split the
  abstract getSchema(tableName?: string): Promise<ColumnInfo[]>;  //  overloaded contract
  abstract getRelations(databaseName?: string): Promise<TableRelation[]>;
  abstract profile(table: string, columns?: string[]): Promise<ColumnProfile[]>;  // new
}
```

`listTables` splits apart the overloaded `getSchema` contract (B9) so every adapter
returns one shape. `profile` is new and is what R3.8 and R3.9 are built on.

**Done when:** all three in-scope sources are reachable, `getSchema` returns an identical shape
across adapters, `profile` works on at least one, and one integration test passes per
source.

### Phase 1 — Governance *(the security floor)*
R1.1, R1.2, R1.3, R1.6. R8.1, R8.2, R8.6. Introduces `node-sql-parser` and the
AST-rewrite pipeline that everything later builds on.
**Done when:** a `DROP TABLE` and an unbounded `SELECT *` are both refused with
structured errors, and no credential appears in any MCP argument.

### Phase 2 — Semantic layer + dry-plan *(the core differentiator)*
R3.1–R3.10 (the full §5 acquisition pipeline). R2.1–R2.3. R4.1–R4.3. R6.1.
**Done when:** an agent answers a business question through a metric it did not have
to infer, a hallucinated column name returns a `did_you_mean` hint, and every
machine-generated MDL entity is marked `verified: false` until reviewed.

### Phase 3 — Memory, CLI, evaluation
R5.1–R5.4. R6.2–R6.4. R7.1–R7.3.
**Done when:** the golden eval reports a pass rate, and `--guided` measurably beats
`--direct` on it.

### Phase 4 — Access control + MongoDB modeling
R8.3–R8.5. D2 revisited: document-source mapping into MDL.
**Done when:** two principals run the same question and get correctly different rows.

### Phase 5 — Dashboards
R9.x, only if a real user asks for it.

---

## 7. Additions beyond the original feature list

Items in this spec that were **not** in the source list, with rationale:

| Req | Addition | Why |
|---|---|---|
| R1.2 | Read-only / DML blocking | The original "governed execution" covered row limits and safe plans but not destructive statements — the larger risk given B2. |
| R1.3–R1.5 | Timeouts, byte caps, cost pre-check | Row limits alone don't stop a slow cartesian join or a blob that floods the context window. |
| R7.x | Golden eval runner + guided-vs-direct benchmark | WrenAI ships one. Accuracy claims are unfalsifiable without it, and it's the regression suite for MDL changes. |
| R3.5, R3.8 | Value profiling / schema drift lint | Distinct-value profiling lets the agent map "California" → `'CA'` — a large real-world text-to-SQL failure mode, and cheap given `getSchema` already exists. |
| R3.6 | Provenance + `verified` flags on MDL entities | A bootstrapped MDL with LLM-invented descriptions launders a guess into ground truth — the exact failure the project exists to prevent (§5.3). |
| R3.9 | Relationship inference without declared FKs | `getRelations` reads FK constraints only (B11); many production databases declare none, yielding an empty relationship graph. |
| R3.10 | Mining existing SQL artifacts | Query logs and dbt/ORM/BI definitions encode real intent — the richest Tier 3 source, and the step most bootstrap tools skip (§5.3). |
| R8.1–R8.2 | Credential handling | Baseline B3: passwords currently transit the LLM context. RLAC is theatre until this is fixed. |
| R8.5 | Audit logging | Access control without an audit trail can't be verified after the fact. |
| R8.6 | Parameter binding | Agent-authored literals are untrusted input. |
| D3 | Explicit principal model | RLAC/CLAC has no meaning without a non-self-asserted identity. |
| R6.5 | SDK deferral | Two SDKs are listed in the source; building either before a consumer exists is speculative. |

Also present in WrenAI but **deliberately excluded**: 22+ connectors (out of scope),
`wren-core-py` bindings (no Python consumer), DataFusion engine (D1).

---

## 8. Open questions

1. **Principal source** — for the stdio MCP deployment, does the principal come from
   an env var, or is `express_server.ts` the intended path for anything multi-user?
   This decides whether R8.3 lands in Phase 4 or moves earlier.
2. **Metric semantics** — are metrics pre-aggregated, or always compiled to live SQL?
   Affects whether a caching layer is needed.
3. **Mongo in scope for MDL** — Phase 4 assumes yes. If Mongo is only ever for
   exploratory use, D2 simplifies and Phase 4 shrinks.
4. ~~**Dialect breadth**~~ — **resolved:** SQL Server is deferred, so the Phase 2
   compiler targets Postgres and MySQL only.
