# data-store-mcp — Test Specification

> Pass/fail criteria for every task in [plan.md](plan.md). Test IDs mirror task IDs:
> task `0.3` is specified by `T0.3`.
>
> A task is **not done** until its `T` block passes and its listed GAP tests have been
> retired. "It works when I try it" is not a completion criterion.

---

## 1. Test levels

| Level | Directory | Speed | What it proves | What it cannot prove |
|---|---|---|---|---|
| **unit** | `tests/unit/` | ms, no I/O | Pure logic: parsing, rewriting, type mapping, error shaping | That it works against a real database |
| **integration** | `tests/integration/` | ~1s | Adapter behaviour against Pagila / Sakila / Mongo | That the MCP tool layer wires it up |
| **e2e** | `tests/e2e/` | ~2s | The real MCP server over stdio, real tool calls | Isolation — a failure needs bisecting |
| **invariant** | `tests/invariant/` | ms | Architectural rules hold repo-wide (arch §7) | Runtime behaviour |

The integration/e2e split is load-bearing: adapter tests bypass the tool registry, zod
schemas, `ConnectionManager` and the response envelope. B14 was invisible until an e2e
test existed. **Every task that changes agent-visible behaviour needs an e2e assertion,
not only a unit one.**

Prefer the cheapest level that can actually fail for the right reason. Governance logic
(Phase 1) is mostly pure AST work and belongs in `unit/`; only the enforcement path needs
an e2e counterpart.

---

## 2. Running

```bash
./scripts/fetch-fixtures.sh   # once — downloads Pagila + Sakila
npm run db:up                 # compose up, waits for data to be loaded
npm run build                 # e2e spawns dist/server.js
npm test                      # full suite
npm test -- tests/unit        # one level
npm run db:reset              # clean re-seed (tmpfs, ~30s)
```

CI gate: `typecheck → build → db:up → test`. All four must pass to merge.

---

## 3. Conventions

**Naming.** `describe` names the unit under test; `it` states the behaviour as a claim
("rejects a multi-statement payload"), never "should work".

**The GAP protocol.** A known defect is encoded as a *passing* test asserting current
behaviour, named `GAP <id>:`, paired with an `it.todo` for the target state. When the fix
lands the GAP test **must fail** — that failure is the signal to delete it and enable the
todo. Each `T` block below lists the GAP tests it retires. A task that leaves its GAP
tests passing has not changed anything.

**Determinism.** Fixture data is read-only. A test needing DDL (comments, permissions)
must create objects prefixed `dsm_test_` and drop them in `afterAll`, or the suite is only
green on a fresh `db:reset`. Never assert on row *ordering* without `ORDER BY`.

**No network.** Tests must not reach the internet. Fixtures come from `fixtures/`, seeded
before the run. Any task requiring an LLM (2.9) is tested against a stubbed client.

**Fixture facts** these specs rely on, all verified:

| Fact | Pagila | Sakila |
|---|---|---|
| `film` rows | 1000 | 1000 |
| `film_actor` FK parents | `actor`, `film` | `actor`, `film` |
| FK count | > 10 | > 10 |
| `public` schema columns | > 50 | — |
| View | — | `customer_list` |

Mongo fixture: 12 `film` docs, 8 `actor` docs, unique index on `film_id`, 5 distinct
ratings (`tests/helpers/seed-mongo.ts`).

---

## 4. Phase 0 — Foundation

### T0.1 — Vitest harness + CI ✅ done
**Level:** meta · **Files:** `vitest.config.ts`, `.github/workflows/ci.yml`

- **PASS** `npm test` exits 0 and reports > 0 tests; `npm run typecheck` exits 0; CI runs
  typecheck, build, `db:up`, test on push and PR.
- **FAIL** Any script missing; CI green while `npm test` fails locally; tests pass with
  zero databases running (means nothing is actually asserted).

### T0.8 — Adapter integration tests ✅ done
**Level:** integration · **Files:** `tests/integration/{postgres.pagila,mysql.sakila,mongodb}.test.ts`

- **PASS** All three adapters connect; `film` count is 1000 (SQL) / 12 (Mongo);
  parameterized queries work; `getRelations` returns `film_actor → {actor, film}`;
  each of B7/B9/B10 has a GAP test.
- **FAIL** Any suite passing while its container is down; assertions on `>0` rows only
  (too weak to catch a wrong database).

### T0.10 — MCP server e2e ✅ done
**Level:** e2e · **File:** `tests/e2e/mcp-server.test.ts`

- **PASS** Server spawns from `dist/server.js`; `tools/list` returns exactly
  `[connect_database, echo, inspect_database, query_database]`; `connect_database` →
  `query_database` → `inspect_database` succeed against both Pagila and Sakila.
- **FAIL** Test passes without `dist/` built (means it isn't running the real server);
  connection IDs leak between tests.

---

### T0.3 — Fix identifier injection
**Level:** integration + unit · **Task:** 0.3 · **Spec:** B10

| | |
|---|---|
| Files | `tests/unit/identifiers.test.ts`, both SQL integration suites |
| Setup | Pagila + Sakila running |

**PASS**
1. `getSchema("film' OR '1'='1")` on Postgres returns `[]` or throws — the injected
   predicate no longer matches every row.
2. `getSchema("film; SELECT 1")` on MySQL throws a validation error, not a driver
   syntax error. The distinction matters: a driver error means the string still reached
   the server.
3. `getSchema('film')` still returns the correct columns on both — the fix must not
   break the happy path.
4. Unit: identifier validator accepts `film`, `film_actor`, `FilmActor`; rejects
   `` ` ``, `'`, `"`, `;`, `--`, `/*`, space, and empty string.
5. MySQL uses backtick quoting **or** an allowlist derived from `listTables()` —
   parameterization is impossible for `DESCRIBE`, so a `?` placeholder is not an
   acceptable fix.

**FAIL**
- Postgres fixed but MySQL left interpolated (the two live in different files; it is easy
  to fix one and declare victory).
- Fix implemented by escaping quotes rather than validating/quoting the identifier.
- Any test asserting the injection still works.

**Retires** `GAP B10` in both SQL suites. **Enables** the two `after 0.3` todos.

---

### T0.11 — Tool errors as `isError` results
**Level:** e2e · **Task:** 0.11 · **Spec:** B14, R2.2

| | |
|---|---|
| File | `tests/e2e/mcp-server.test.ts` |
| Setup | Pagila connected |

**PASS**
1. `query_database` with an unknown `connectionId` **resolves** (does not reject) with
   `isError: true` and content matching `/Connection not found/`.
2. `query_database` on a SQL source with no `sql` resolves with `isError: true`.
3. A driver-level failure (`SELECT * FROM no_such_table`) resolves with `isError: true`
   and does not crash the server — a subsequent valid call on the same client succeeds.
4. An unknown **tool** still rejects at protocol level. This is the correct behaviour and
   must not be "fixed" alongside the others.
5. No error path leaks a connection password into the response.

**FAIL**
- Errors returned as `isError` but with an empty or generic message ("Tool execution
  failed") — the point is that the agent can read and act on it.
- Server process exits on a bad query.
- Test asserts only that the promise resolves, without checking `isError`.

**Retires** both `GAP B14` tests. **Enables** the `after R2.2` todo.

---

### T0.2 — Typed connection options
**Level:** unit (type-level) · **Task:** 0.2 · **Spec:** B5

**PASS**
1. `npm run typecheck` passes with `ConnectionConfig.options` as a discriminated union
   keyed on `type`.
2. A type test asserts `@ts-expect-error` on constructing a `postgres` config carrying
   Mongo's `uri`, and on a `mongodb` config missing `uri`.
3. No `any` remains in `src/database-source.ts`.

**FAIL** Union declared but adapters still cast with `as any` internally — grep
`src/**/*.ts` for `as any` on config access must return nothing.

---

### T0.4 — Introspection types
**Level:** unit (type-level) · **Task:** 0.4 · **Spec:** §5.1

**PASS** `ColumnInfo`, `TableInfo`, `ColumnProfile` exist with the fields named in
architecture §5; typecheck passes; no runtime behaviour changes (full suite still green).

**FAIL** Types defined but unused by any adapter — this task is only meaningful as a
prerequisite, so it is done when T0.5 can be written against it.

---

### T0.9 — `getRelations` substitutability
**Level:** unit + integration · **Task:** 0.9 · **Spec:** B12

**PASS**
1. `MysqlDatabase.getRelations()` called with no argument returns Sakila's FKs, falling
   back to the configured database.
2. Type test: `const db: Database = new MysqlDatabase(cfg)` then `db.getRelations()`
   typechecks with no cast.
3. Signature is `getRelations(databaseName?: string)` in all three adapters.

**FAIL** Test still needs `(db as any)` to call it. **Retires** the `GAP:` substitutability
test in the MySQL suite.

---

### T0.5 — Uniform `getSchema` + `listTables`
**Level:** integration · **Task:** 0.5 · **Spec:** B7, B9, B13

| | |
|---|---|
| Files | all three integration suites + a shared contract suite |
| Setup | all three containers |

**PASS**
1. **Contract test** — a single parameterized suite runs the same assertions against all
   three adapters:
   - `getSchema('film')` returns `ColumnInfo[]` with identical **key names** across
     adapters (`table`, `name`, `dataType`, `nullable`, …). This is the assertion that
     kills B13.
   - Every element has `table === 'film'` — kills B7.
   - `getSchema()` with no argument returns columns for **all** tables, each carrying its
     `table` — and `new Set(cols.map(c => c.table)).size > 1`.
   - `listTables()` returns `TableInfo[]` including `film` and `actor`; it never returns
     columns — kills B9.
2. Postgres `getSchema()` returns > 50 columns spanning > 5 distinct tables.
3. `dataType` is normalized enough to compare: `film.title` reports a string-family type
   on both Postgres and MySQL.
4. Mongo implements both, deriving `ColumnInfo` from sampled fields.

**FAIL**
- Per-adapter assertions instead of one shared contract suite — the whole point is
  cross-adapter uniformity, and separate suites let shapes drift again.
- `listTables()` implemented as `getSchema()` with a distinct filter (loses table metadata).

**Retires** all `GAP B7` and `GAP B9` tests, including the e2e `GAP B7`. **Enables** the
three `after 0.5` todos.

---

### T0.6 — Keys, defaults, comments
**Level:** integration · **Task:** 0.6 · **Spec:** B8, §5.1

| | |
|---|---|
| Setup | `beforeAll` sets a comment on a scratch object; `afterAll` drops it |

Do **not** assume Pagila or Sakila ship column comments — seed them:

```sql
-- Postgres           COMMENT ON COLUMN film.title IS 'dsm_test comment';
-- MySQL              ALTER TABLE film MODIFY title VARCHAR(128) NOT NULL COMMENT 'dsm_test comment';
```

**PASS**
1. `film.film_id` has `isPrimaryKey: true`; `film.title` has `isPrimaryKey: false`.
2. At least one column reports `isUnique: true` (Pagila/Sakila both have unique indexes).
3. A column with a database default reports it; one without reports `undefined` —
   assert both directions, or a stub that always returns `undefined` passes.
4. The seeded comment round-trips into `ColumnInfo.comment` on both engines.
5. Comment is `undefined`, not `''` or `null`, where none exists.

**FAIL**
- Test asserts comments using a comment the fixture happens to ship (fragile across
  Pagila versions).
- Only the positive case asserted (see 3).
- Composite primary keys mis-reported: `film_actor` has a two-column PK and **both**
  columns must report `isPrimaryKey: true`.

---

### T0.7 — `profile()`
**Level:** integration · **Task:** 0.7 · **Spec:** R3.8

**PASS**
1. `profile('film', ['rating'])` returns `distinctCount === 5` and `topValues` covering
   `G`, `PG`, `PG-13`, `R`, `NC-17`, each with a `count`, sorted descending.
2. `topValues` counts sum to ≤ 1000 and each is > 0.
3. `profile('film', ['film_id'])` reports `distinctCount === 1000` and **omits**
   `topValues` — a high-cardinality column must not return 1000 values into the agent's
   context. Assert `topValues` is `undefined`, not a truncated list.
4. `nullRate` is `0` for `film.title` (NOT NULL) and `> 0` for a nullable column with
   nulls present.
5. `min`/`max` populated for a numeric or date column, absent for text.
6. Profiling all columns of `film` completes in < 5s against the fixture.
7. Profiling is read-only: a `GRANT SELECT`-only role can run it.

**FAIL**
- `topValues` returned for a unique key (context blowup, criterion 3).
- `distinctCount` implemented as `SELECT DISTINCT` materialized in Node rather than
  `count(distinct …)` in SQL.
- Cardinality threshold hardcoded with no way to configure it.

---

**Phase 0 done when:** T0.1–T0.11 all pass, every `GAP B7/B9/B10/B12/B13/B14` test is
deleted, and the 9 `it.todo` entries are implemented or explicitly re-scoped.

---

## 5. Phase 1 — Governance

Mostly pure AST logic → mostly `tests/unit/`. Each enforcement task additionally needs
**one** e2e assertion proving the rule holds through the real tool call, because unit
tests on a rewriter prove nothing about whether the rewriter is actually wired in.

### T1.1 — SQL parser
**Level:** unit · **PASS** Parses `SELECT`, CTEs, subqueries, joins, window functions on
both dialects; returns a `StructuredError` with `location: {line, column}` for a syntax
error; `SELECT * FROM film` and its MySQL equivalent both parse. **FAIL** Parser errors
surfaced as raw exceptions; dialect ignored (a MySQL-only construct parsing as Postgres).

### T1.2 — Error taxonomy
**Level:** unit · **PASS** Every code in R2.2's union is constructible; each carries a
non-empty `message`; `E_UNKNOWN_COLUMN` requires `didYouMean`. **FAIL** Free-form string
errors anywhere in `governance/`; codes not exhaustively switchable (no compile error when
one is unhandled).

### T1.3 — Read-only enforcement
**Level:** unit + e2e · **PASS**
1. Rejects `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `GRANT`, `CREATE`,
   `CALL` — one case each, `E_WRITE_FORBIDDEN`.
2. Rejects multi-statement `SELECT 1; DROP TABLE film`.
3. Rejects a writing CTE (`WITH x AS (DELETE … RETURNING *) SELECT * FROM x`) — this is
   the case a naive "root node is SELECT" check misses.
4. Accepts read-only CTEs, `UNION`, subqueries.
5. **e2e:** `query_database` with `DROP TABLE film` returns `isError`, and `film` still
   has 1000 rows afterwards.
**FAIL** Blocklist by keyword matching rather than AST inspection (`SELECT 'drop table'`
must be *allowed*); criterion 3 skipped.

### T1.4 — Branded `QueryPlan`
**Level:** unit + invariant · **PASS** `execute()` accepts only a `QueryPlan`; a
type test `@ts-expect-error`s on passing a string or an object literal; **invariant test**
greps `src/` and asserts no file outside `src/governance/` constructs a plan. **FAIL**
Brand implemented but an exported factory lets any module mint one.

### T1.5 — Row limits
**Level:** unit + e2e · **PASS**
1. `SELECT * FROM film` → `LIMIT 1000` injected; e2e returns exactly 1000 rows.
2. User `LIMIT 10` preserved (smaller wins).
3. User `LIMIT 999999` clamped to the ceiling.
4. Injected into the AST — assert on the parsed tree, not `sql.includes('LIMIT')`.
5. ~~Applied to each arm of a `UNION`, and to subqueries.~~ **Corrected during
   implementation:** both change results and must *not* be done. A `UNION`'s limit belongs
   to the union as a whole (the parser attaches it to the last arm, which is where SQL puts
   it); limiting each arm returns different rows. Truncating a subquery in
   `WHERE x IN (…)` returns silently wrong rows — the exact "confidently wrong" failure
   §1 exists to prevent. **Only the outermost statement is limited**, and a test asserts a
   subquery is left alone.
6. `appliedLimit` reported on the plan so the agent knows truncation occurred.
7. Operand order is separator-dependent and must be handled: `LIMIT 1,2` puts the limit
   *second*, and a bare `OFFSET 5` has no limit at all despite the `offset` separator.
   Reading index 0 unconditionally clamps the wrong number.
**FAIL** String concatenation of `' LIMIT n'`; a query already ending in a comment or
semicolon breaking the rewrite; criterion 2, 3 or 7 missing.

### T1.6 — Timeouts
**Level:** integration · **PASS** `SELECT pg_sleep(5)` with a 1s timeout rejects with
`E_TIMEOUT` in < 2s **and** `pg_stat_activity` shows the backend gone — proving real
cancellation, not an abandoned promise. Equivalent for MySQL (`SELECT SLEEP(5)` +
`SHOW PROCESSLIST`). **FAIL** Only the promise timing asserted; connection left unusable
for the next test.

### T1.7 — Parameter binding
**Level:** unit + integration · **PASS** Literals become `$1`/`?` with a params array;
`O'Brien` round-trips; a value containing `'; DROP TABLE film; --` returns zero rows and
leaves `film` intact. **FAIL** Escaping instead of binding.

### T1.8 — Mongo gate
**Level:** unit + integration · **PASS** `deleteMany`/`insertOne`/`dropDatabase`/`$out`/
`$merge` rejected; `find` without `limit` gets the default; pipeline > N stages rejected;
`countDocuments` (no limit concept) still allowed. **FAIL** Only the operation name
checked — `$out` inside an otherwise-read `aggregate` pipeline must be caught.

### T1.9 — Config-driven sources
**Level:** e2e · **PASS** Sources load from config at startup; `list_sources` returns them;
`connect_database` is **absent** from `tools/list`; no tool schema has a `password`
property; a full `tools/list` + `tools/call` transcript grep for the fixture password finds
nothing. **FAIL** Tool removed but credentials still echoed in `list_sources` output.

### T1.10 — Byte cap
**Level:** integration · **PASS** A row set exceeding the cap returns `E_RESULT_TOO_LARGE`
with the actual size; the cap is evaluated **during** streaming, not after buffering
everything (assert peak memory or that a 10× cap query fails fast). **FAIL** Cap applied
after full materialization — the OOM it exists to prevent already happened.

### T1.11 — Audit log
**Level:** integration · **PASS** One record per execution including failures and timeouts;
contains principal, source, SQL, applied policies, row count, duration, outcome; append-only
(a second run does not rewrite the first); passwords never appear. **FAIL** Only successes
logged.

**Phase 1 done when:** all T1.x pass, plus the two invariant tests from architecture §7.

---

## 6. Phase 2 — Semantic layer

### T2.1 — MDL types + YAML schema
**Level:** unit · **Spec:** R3.2
**PASS** Every entity in R3.2 (model, column, relationship, metric, view, cube) round-trips
YAML → object → YAML unchanged; an unknown top-level key is rejected with a line number; a
relationship missing its join keys is rejected; `provenance` accepts only the six documented
values; `verified` defaults to `false` when absent.
**FAIL** Schema accepts an unknown key silently; `verified` defaulting to `true`.

### T2.2 — Registry load + index
**Level:** unit · **Spec:** R3.1, R3.6
**PASS** Loads a directory of YAML files into one registry; duplicate model name across two
files is an error naming both paths; a relationship referencing an undefined model is a load
error; lookup by model and by metric name is O(1) and case-sensitive; loading is order-
independent (shuffle the file list, get an identical registry).
**FAIL** Invalid MDL loading with silent defaults; registry contents depending on file order.

### T2.3 — Join paths
**Level:** unit · **PASS** Single-hop `film → language`; two-hop `actor → film_actor → film`;
ambiguous path (two routes) returns an error naming both, never picks one silently;
no path returns `E_NO_JOIN_PATH`; self-referencing FK (`staff.reports_to`) terminates.
**FAIL** Ambiguity resolved by traversal order — the same MDL must not give different SQL
depending on file ordering.

### T2.4 — MDL → SQL compiler
**Level:** integration · **PASS** A metric compiles and **executes** against Pagila and
Sakila with matching results (same dataset, so the numbers must agree across engines —
this is the strongest available check on dialect correctness); generated SQL passes the
Phase 1 gate unchanged; identifiers quoted per dialect.
**FAIL** Golden-string comparison of generated SQL only, without executing it.

### T2.5 — `did_you_mean`
**Level:** unit · **PASS** `titel` → suggests `title`; `flim` → `film`; suggestions ranked
by edit distance, capped at 3; a completely unrelated token returns an empty array rather
than nonsense; CLAC-hidden columns never appear in suggestions (a suggestion is an
information leak).
**FAIL** Suggestions drawn from the live schema instead of the MDL registry.

### T2.6 — `dry_plan`
**Level:** e2e · **PASS** Returns resolved tables/columns, applied limit, applied policies;
**executes nothing** — assert via audit log that no execution record was written; an
invalid query returns structured errors; a query touching an unverified model returns
`E_UNVERIFIED_MODEL` as a warning without failing.
**FAIL** `dry_plan` runs the query and discards results.

### T2.7 — Tool surface
**Level:** e2e · **PASS** `tools/list` returns exactly the R6.1 six; `describe_model`
returns descriptions and profiled top-values; old tools absent.

### T2.8 — `mdl bootstrap`
**Level:** integration · **Spec:** R3.7, §5.4
**PASS** Bootstrapping Pagila emits one model per table covering every column; each column's
`dataType` matches `getSchema`; every entity is `verified: false` with `provenance:
introspection`; profiled top-values are attached for low-cardinality columns; re-running is
idempotent (identical output, no duplicated models); output parses under T2.1's schema.
**FAIL** Any entity emitted `verified: true`; second run appending duplicates; a table
skipped silently because introspection returned an unexpected shape.

### T2.9 — LLM drafting
**Level:** unit · **Spec:** R3.7, §5.3
**PASS** LLM client is **stubbed** — no network call in CI. Assert the assembled prompt
contains the table name, column list and profiled values; a stubbed response becomes
`description` with `provenance: llm_draft` and `verified: false`; a stub returning malformed
output leaves the entity description empty rather than crashing the run; a stub that returns
`verified: true` in its payload is ignored — verification is not the model's to grant.
**FAIL** Any live model call in the test suite; generated content marked verified; prompt
asserted only by length.

### T2.10 — Artifact mining
**Level:** integration · **Spec:** R3.10, §5.3
**PASS** Given a checked-in fixture query log, repeated join patterns emit relationship
candidates ranked by frequency; a `WHERE` clause present in ≥ N logged queries emits a
proposed business rule; all output is `provenance: query_log, verified: false`; an
unparseable log line is skipped with a warning, not fatal.
**FAIL** Requires a live `pg_stat_statements` (untestable in CI — the fixture log must be a
committed file); a single occurrence treated as a pattern.

### T2.11 — Relationship inference
**Level:** integration · **Spec:** R3.9, B11
**PASS** Against a scratch copy of Pagila with FK constraints dropped, inference recovers
`film_actor → film` and `film_actor → actor` via name convention → type compatibility →
value-overlap sampling. Two same-named columns of compatible type with **zero** value overlap
are **not** proposed. Candidates carry a confidence score and `verified: false`.
**FAIL** Only the positive case asserted — the negative case is what separates inference from
name matching. Proposals emitted as facts.

### T2.12 — `mdl lint` (drift)
**Level:** integration · **Spec:** R3.5
**PASS** Detects each of: model referencing a dropped table, column removed from the database,
column type changed, declared relationship with no matching FK. Clean MDL against an unchanged
database exits 0. Each finding names the file and line.
**FAIL** Lint passing on MDL that references a nonexistent table; drift reported without a
location.

### T2.13 — Context files
**Level:** unit · **Spec:** R4.1, R4.2
**PASS** `instructions.md` loads as text into context assembly; `queries.yml` parses into
question/SQL pairs; malformed YAML errors with a line number; both files absent is not fatal
(empty context, not a crash); a `queries.yml` entry missing `sql` is rejected.
**FAIL** A parse failure silently yielding empty context — the agent would then run with no
business rules and no signal that they were dropped.

### T2.14 — Description coverage
**Level:** unit · **Spec:** R3.3
**PASS** A model, column or metric with a missing or empty `description` is a **lint error**,
not a warning; whitespace-only counts as missing; the error names the entity path
(`model.film.column.title`); a fully described MDL passes.
**FAIL** Treated as a warning (R3.3 calls an undescribed model a modeling bug); inherited or
auto-filled descriptions counting as present.

---

## 7. Phase 3 — Memory, CLI, evaluation

Blocks are shorter than Phase 0–1 because these depend on decisions still open in spec.md §8,
but every task has its own pass/fail criteria.

### T3.1 — Golden eval runner
**Level:** integration · **Spec:** R7.1
**PASS** Executes every `queries.yml` pair against the fixtures and reports a pass rate;
result comparison is order-insensitive unless the query has `ORDER BY`; a deliberately broken
pair is reported as failing, not skipped; exits non-zero below a configured threshold; output
names each failing case.
**FAIL** Comparing row order without `ORDER BY` (flaky by construction); an unrunnable case
counted as a pass; threshold not enforced in the exit code.

### T3.2 — Eval in CI
**Level:** meta · **Spec:** R7.3
**PASS** CI runs the golden eval when `semantic/**` or `queries.yml` changes; a seeded MDL
regression fails the build; pass rate is recorded per run so a trend is visible.
**FAIL** Advisory-only (`continue-on-error`); eval skipped when only MDL changed — that is
exactly the change it exists to guard.

### T3.3 — Memory index
**Level:** integration · **Spec:** R5.1
**PASS** A successful execution is indexed with question, SQL, result shape and timing;
re-indexing the same question updates rather than duplicates; the index survives a process
restart; a failed execution is **not** indexed.
**FAIL** Failures indexed as precedents (poisons retrieval); index rebuilt from scratch on
every start.

### T3.4 — Hybrid retrieval
**Level:** integration · **Spec:** R5.2
**PASS** An exact table-name query retrieves the matching precedent (the BM25 half); a
paraphrase with no lexical overlap retrieves it too (the vector half); RRF ranking is
asserted against a fixed fixture set with a fixed seed; disabling either half measurably
degrades one of those two cases.
**FAIL** Only vector search tested — the documented reason for hybrid is that pure vector
misses exact table-name matches, so that case must be covered explicitly.

### T3.5 — `search_context` tool
**Level:** e2e · **Spec:** R5.3, R6.1
**PASS** Returns precedents explicitly labeled as prior art; the label is present in the tool
output the model sees, not only in internal metadata; unverified-model precedents carry the
warning; empty result set returns an empty list, not an error.
**FAIL** Precedents returned indistinguishable from ground truth.

### T3.6 — Promotion to `queries.yml`
**Level:** integration · **Spec:** R5.4
**PASS** An explicitly approved query is appended to `queries.yml` in valid schema and becomes
a golden eval case on the next run; promotion requires an explicit approval flag; the diff is
reviewable (stable key order, no reformatting of existing entries).
**FAIL** Automatic promotion without approval — R4.3 requires the agent's knowledge to be
reviewable, and silent writes defeat that.

### T3.7 — CLI core commands
**Level:** integration · **Spec:** R6.2
**PASS** `serve`, `mdl lint`, `mdl bootstrap`, `query --sql` each exit 0 on valid input and
non-zero on invalid; `--help` works for each; `query --sql` output is machine-readable
(`--json`); errors go to stderr, data to stdout.
**FAIL** Exit code 0 on failure; diagnostics on stdout (breaks piping).

### T3.8 — `ask --guided` / `--direct`
**Level:** integration · **Spec:** R6.4
**PASS** With a stubbed LLM, `--guided` assembles schema + `instructions.md` + retrieved
precedents into the prompt and `--direct` includes none of them; the two produce demonstrably
different prompts for the same question; guided context respects CLAC (hidden columns absent
from the prompt).
**FAIL** Difference asserted only by output text rather than by prompt content; hidden columns
leaking into the prompt.

### T3.9 — Guided-vs-direct benchmark
**Level:** integration · **Spec:** R7.2
**PASS** Runs both modes over the same golden set with a fixed seed and reports both pass
rates plus the delta; the run is reproducible (same seed → same result); the report states the
sample size.
**FAIL** A single run's delta reported as conclusive; different question sets used per mode.

### T3.10 — `skills get` / `skills add`
**Level:** integration · **Spec:** R6.3
**PASS** `skills get onboarding` emits the workflow guide as structured markdown on stdout and
exits 0; an unknown skill name exits non-zero with the available names listed; `skills add`
writes a discovery stub into the target client's config and is idempotent (running twice
leaves one entry); every shipped skill is retrievable — a test iterates the skills directory
rather than hardcoding names, so a new skill that fails to load breaks the build.
**FAIL** Skill list hardcoded in the test (a broken skill file passes); `skills add`
duplicating entries or clobbering unrelated config keys.

---

## 8. Phase 4 — Access control + Mongo modeling

### T4.1 — Principal model
**Level:** e2e · **Spec:** D3
**PASS** stdio server reads the principal from config/env at startup; HTTP server takes it
per-request from the host application; a principal supplied as an **MCP tool argument is
ignored** — a tool call carrying `{principal: 'admin'}` resolves with the configured
principal's permissions, not admin; missing principal fails closed (startup error or
least-privilege), never open.
**FAIL** Any path where model-supplied input influences identity. This is the escalation
vector D3 exists to close, so the negative test is the important one.

### T4.2 — Policy engine
**Level:** unit · **Spec:** R8.3
**PASS** A principal resolves to its RLAC predicates and CLAC column set; unknown principal
yields the most restrictive policy, not an empty (permissive) one; policies compose
predictably when a principal has multiple roles; policy resolution is pure and side-effect
free.
**FAIL** Unknown principal resolving to no restrictions.

### T4.3 — RLAC injection
**Level:** integration · **Spec:** R8.3
**PASS** A principal scoped to `store_id = 1` running `SELECT * FROM customer` gets only
store 1 rows; the predicate appears in the compiled SQL, asserted on the plan, not just on the
row count; agent SQL containing `OR 1=1`, a trailing comment, or a `UNION` to an unscoped
select **still** returns only scoped rows; the predicate is applied to every referenced
occurrence of the model, including inside subqueries and CTEs.
**FAIL** Predicate appended as a string rather than injected post-parse; only the simple
`SELECT` case tested — the bypass attempts are the point.

### T4.4 — CLAC
**Level:** e2e · **Spec:** R8.4
**PASS** A hidden column is absent from `describe_model`, from `did_you_mean` suggestions,
from `dry_plan` metadata, and from any error message; explicitly selecting it returns
`E_POLICY_DENIED` rather than a null column; `SELECT *` expands to visible columns only.
**FAIL** Column hidden from `describe_model` but still returned by `SELECT *` — a partial
implementation is worse than none, since it reads as enforced.

### T4.5 — Policy audit
**Level:** integration · **Spec:** R8.5
**PASS** Every audit record lists the applied policies by name, including the empty case
(explicitly "none applied", so absence is distinguishable from a bug); denied requests are
audited with the reason.
**FAIL** Only allowed requests audited.

### T4.6 — Mongo → MDL mapping
**Level:** integration · **Spec:** D2
**PASS** A seeded collection maps to a model with fields inferred by sampling N documents
(not one — see T0.7's Mongo gap); a `$lookup` maps to a relationship; embedded documents map
to nested columns or are explicitly declared unsupported; heterogeneous field types are
reported as a union rather than the first-seen type.
**FAIL** Field inference from a single document; type conflicts silently resolved to the
first value seen.

---

## 9. Phase 5 — Dashboards

### T5.1 — Dashboard generation
**Level:** integration · **Spec:** R9.1
**PASS** Output is a single self-contained file with **no external requests** — assert by
scanning the generated HTML for `http://`, `https://`, `src=`, `fetch(`; data is embedded;
the page renders the metric values it was generated from; filters operate on embedded data.
**FAIL** Any CDN script or remote font; data fetched at view time from a source requiring
credentials.

### T5.2 — Deployment
**Level:** integration · **Spec:** R9.3
**PASS** Deploy is exercised against a **stubbed** provider API in CI, never a live one;
produces a URL; failure of the provider is reported, not swallowed.
**FAIL** Any test that performs a real deployment.

### T5.3 — Deploy confirmation gate
**Level:** integration · **Spec:** R9.4
**PASS** Deployment requires explicit human confirmation; invoking deploy programmatically
without the confirmation token fails closed; no agent-reachable tool or flag can supply the
token on the model's behalf; the confirmation prompt states that data will be published
publicly.
**FAIL** A `--yes`/`--force` flag reachable from an agent tool call. R9.4 makes this
non-negotiable: deployment publishes data to the public internet.

---

## 10. Cross-cutting invariant tests

From architecture §7 — repo-wide rules, `tests/invariant/`. Each is one test that must
never be skipped.

| # | Invariant | How it is tested |
|---|---|---|
| 1 | No tool→driver path accepts a string | Type test: `execute()` rejects `string` |
| 2 | Only `governance/` constructs a `QueryPlan` | Static scan of `src/` for the brand |
| 3 | RLAC injected after parsing agent SQL | Agent SQL with `OR 1=1` still yields scoped rows |
| 4 | CLAC columns never surfaced | Hidden column absent from `describe_model`, errors, suggestions |
| 5 | Credentials never in tool I/O | Grep a full session transcript for the fixture password |
| 6 | One audit record per execution | Count records before/after a mixed success/failure batch |
| 7 | Unverified MDL always announced | Query against unverified model carries the warning |

---

## 11. Coverage map

Every task in [plan.md](plan.md) must appear here with its own `T` block. This table is the
check against silent drift — a task added to plan.md without a `T` block is an incomplete
task, and a `T` block with no task is a stale spec.

| Phase | Tasks | `T` blocks | Covered |
|---|---|---|---|
| 0 | 0.1–0.11 (11) | T0.1, T0.2, T0.3, T0.4, T0.5, T0.6, T0.7, T0.8, T0.9, T0.10, T0.11 | 11/11 |
| 1 | 1.1–1.11 (11) | T1.1 … T1.11 | 11/11 |
| 2 | 2.1–2.14 (14) | T2.1 … T2.14 | 14/14 |
| 3 | 3.1–3.10 (10) | T3.1 … T3.10 | 10/10 |
| 4 | 4.1–4.6 (6) | T4.1 … T4.6 | 6/6 |
| 5 | 5.1–5.3 (3) | T5.1, T5.2, T5.3 | 3/3 |
| — | invariants (7) | §10 | 7/7 |

**Total: 55 tasks, 55 specifications.**

Verify with:

```bash
diff <(grep -oE '^\| [0-9]+ \| [0-9]+\.[0-9]+|^\| [0-9]+\.[0-9]+' plan.md \
        | grep -oE '[0-9]+\.[0-9]+$' | sort -u) \
     <(grep -oE '^### T[0-9]+\.[0-9]+' test.md | sed 's/### T//' | sort -u)
```

Empty output means full coverage.

---

## 12. Deliberately not tested

Stated so the gaps are choices rather than oversights:

- **Live LLM calls.** Non-deterministic and costly; 2.9 stubs the client. Real model
  quality is measured by the golden eval (3.1), not by unit tests.
- **SQL Server.** Deferred with the adapter.
- **Concurrency/load.** No throughput or connection-pool-exhaustion tests until there is a
  performance requirement to test against.
- **The Express server.** [src/express_server.ts](src/express_server.ts) is currently a
  standalone script with its own pool, not wired to the MCP core. It gets tests when task
  4.1 decides whether it is the multi-user path.
- **`echo` tool.** Trivial, and slated for deletion in 2.7.
