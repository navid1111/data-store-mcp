# data-store-mcp — What It Is, In The Order It Was Built

> 63 commits. The sequence is the argument: each block of commits establishes one
> claim, and none of them could have come earlier than it did.
>
> Every command below was run against the live fixtures before this was written.
>
> Docs: [spec.md](spec.md) · [architecture.md](architecture.md) · [plan.md](plan.md) · [test.md](test.md)

---

## The shape of the history

| Commits | Block | The claim it establishes |
|---|---|---|
| 1–8 | The starting point | An agent can reach a database |
| 9–11 | Tests and specs | …and here is what was actually wrong with that |
| 12–19 | **Phase 0** — Foundation | The schema can be described uniformly |
| 20–30 | **Phase 1** — Governance | The agent cannot damage or exfiltrate |
| 31–44 | **Phase 2** — Semantic layer | The agent stops guessing, and fails usefully |
| 45–54 | **Phase 3** — Memory, CLI, eval | The accuracy claim is testable |
| 55–60 | **Phase 4** — Access control | Two people get different answers |
| 61–63 | **Phase 5** — Dashboards | The result leaves the terminal |

Read down that table and you have the product. The rest of this document is the
detail, with the command that proves each block.

---

## Move 0 — The starting point (commits 1–8)

```
742a450  echo tool + project structure
8caa785  database connection and query tools, MySQL + PostgreSQL
e7b9e54  schema verification and an E2E test
a2e3e5f  SQL Server support, richer inspection
702a8de  MongoDB support
```

Eight commits produced a working MCP server: `connect_database`, `query_database`,
`inspect_database`, four adapters. **This already worked.** An agent could connect and
run SQL.

That is the thing to say out loud at the start of a demo, because everything after it
is an argument about why "it works" wasn't enough:

- The agent authored SQL against a schema it had never seen, so it guessed column names.
- `query_database` passed that SQL straight to the driver — no row limit, no read-only
  check, no timeout.
- Credentials arrived as tool arguments, which means they passed through the model's
  context.
- Every caller saw everything the connection could reach.

---

## Move 1 — Find out what's actually broken (commits 9–11)

```
906fa06  end-to-end and integration tests for Mongo, MySQL, PostgreSQL
03a3cbf  test.md — pass/fail criteria for every task
```

Before changing anything, the codebase got a test harness against **real** databases —
Pagila (Postgres) and Sakila (MySQL) in Docker, plus a seeded Mongo — and every known
defect was committed as a *passing* test asserting the broken behaviour.

That convention runs through the whole history. A defect is written down as a `GAP`
test that documents what the code does today. When the fix lands, **the GAP test
fails** — and that failure is the signal to delete it. Fourteen were written. All
fourteen are now gone.

This move is why the rest of the history is trustworthy, and it's worth one line in a
demo: *the bugs were proven before they were fixed.*

---

## Move 2 — Phase 0: make the schema describable (commits 12–19)

```
4d44202  SQL identifier validation and quoting  (injection)
c0b8128  error shaping and secret redaction
f0b9e08  ConnectionConfig.options as a discriminated union
a8b8579  uniform introspection types
d6b5383  getRelations substitutable for its base type
c197613  uniform getSchema + listTables across all three adapters
74ec56c  verify keys, defaults and comments on both engines
c50261e  profile() for column statistics
```

None of this is user-visible. It exists because **the semantic layer in Move 4 cannot
be built on introspection that disagrees with itself.**

What was wrong: Postgres returned `column_name`/`data_type`, MySQL returned `DESCRIBE`
output with `Field`/`Type`, Mongo returned collection summaries. Calling `getSchema()`
with no table name returned columns with *no indication which table they belonged to*.
There was no way to get a primary key, a default, or a column comment.

`c197613` made all three return one `ColumnInfo[]` shape, and split `listTables()` out
of the overloaded contract. `c50261e` added `profile()` — distinct counts, null rates,
top values — which is what later lets an agent map "California" to `'CA'`.

Two things in this block are worth showing:

**`4d44202`** — the injection. `getSchema` interpolated the table name into SQL.
Postgres could bind it; MySQL's `DESCRIBE` cannot take a bind parameter at all, so it
needed a validator instead. Different fixes, same rule.

**`c50261e`** — profiling a primary key returns *no* top values rather than 1,000
truncated ones. Flooding the agent's context is the failure this exists to avoid.

```bash
head -20 demo/pagila.mdl.yml     # the introspection this block made possible
```

---

## Move 3 — Phase 1: the floor (commits 20–30)

```
95bcb63  structured error taxonomy
cf332be  SQL parser
d27f49e  read-only enforcement over the AST
fab3f1c  branded QueryPlan as the only executable input
fc51b13  row limits, and query_database wired through the gate
2feb4a7  prove caller values can never become SQL syntax
073dcfa  query timeouts with real server-side cancellation
689eeb7  Mongo query governance
4e2ae8e  load database sources from startup config
acd6532  streaming result byte caps
acdda8c  append-only execution audit log
```

Eleven commits, and this is the block that changes what the product *is*. Note it
comes **before** the semantic layer — building features on top of an ungoverned
execution path would have widened the hole.

The order inside the block matters too. `d27f49e` (read-only) and `cf332be` (parser)
land before `fab3f1c` (the plan type), because the plan type is what makes the gate
non-bypassable and there's no point branding a plan you can route around.

### Live: an unbounded query becomes bounded

```bash
node dist/cli/index.js query --source pagila \
  --sql "SELECT title, rating FROM film" --config demo/config.json --json | head -c 200
```
```json
{"source":"pagila","appliedLimit":1000,"appliedPolicies":["limit:1000","read-only"],"rows":[...
```

No limit was asked for. One was injected — into the syntax tree, not by appending
`LIMIT 1000` to the text, which breaks on a trailing comment. And the response *says*
it was truncated.

### Live: the refusal worth pausing on

```bash
node dist/cli/index.js query --source pagila \
  --sql "WITH x AS (INSERT INTO film (title) VALUES ('x') RETURNING *) SELECT * FROM x" \
  --config demo/config.json
```

That statement's **root node is a `SELECT`.** The write hides inside the CTE. Any
implementation that asks "is this a SELECT?" lets it through — and so does
`SELECT * INTO new_table FROM film`, and `SELECT 1; DROP TABLE film`.

All three were found by probing the parser's real output rather than trusting a mental
model of it, and all three are in the suite by name.

### The mechanism (`fab3f1c`)

Adapters expose `execute(plan)`. It accepts a `QueryPlan` — a type branded with a
`unique symbol` that the governance module does not export. No object literal can
satisfy it. **There is no function anywhere that runs agent SQL as a string.** Bypassing
the gate isn't discouraged by convention; it fails to compile.

### `4e2ae8e` — where the credentials went

`connect_database` was deleted. Sources come from a config file at startup, so a
password never appears in a tool argument and the agent cannot open an unmanaged
connection.

### `acdda8c` — the audit trail

```bash
tail -2 demo/audit.jsonl
```
```json
{"principal":"demo-analyst","sql":"DROP TABLE film","outcome":"denied","errorCode":"E_WRITE_FORBIDDEN",...}
{"principal":"demo-analyst","sql":"SELECT title FROM \"film\" LIMIT 1000","rowCount":1000,"outcome":"success",...}
```

One record per execution — successes, denials and timeouts alike.

---

## Move 4 — Phase 2: ground truth (commits 31–44)

```
edb653e  strict MDL YAML schema
dbf9209  load and index the semantic registry
7298970  deterministic join paths
b994795  compile semantic metrics to governed SQL
654c3cc  identifier resolution with suggestions
8069cd6  non-executing dry_plan
995414f  the final MCP tool surface
7f07ed6  bootstrap idempotent MDL from introspection
3434587  stubbed MDL drafting boundary
b420333  mine repeated SQL artifact patterns
88dfa24  infer undeclared relationships safely
8168a3b  lint MDL against live schema drift
e4203ec  load versioned project context
b0385d2  enforce description coverage
```

This is the differentiator. Everything before it made the agent *safe*; this block
makes it *correct*.

The core asset is the MDL — models, columns, relationships, metrics in Git-tracked
YAML. `7f07ed6` generates a first draft from introspection and profiling; `3434587`
lets an LLM draft descriptions.

**The single most opinionated decision in the project is in `edb653e`:** every entity
carries `provenance` and `verified`, and generated content is always `verified: false`.

A bootstrapped model full of LLM-invented descriptions is *worse than no model*,
because it launders a guess into apparent ground truth — the exact failure the whole
system exists to prevent. Nothing is trusted until a human flips that flag in a pull
request. The review **is** the acquisition step, not paperwork afterwards.

`b420333` and `88dfa24` are the parts most tools skip: mining real query logs for join
patterns and business rules, and inferring relationships when a database declares no
foreign keys — with the negative case tested, so a same-named column with zero value
overlap is *not* proposed.

### Live: the anti-hallucination loop

```bash
node demo/mcp-demo.mjs
```
Drives the real MCP server over stdio, as an agent would:

```json
── dry_plan with a typo
{"isError": true,
 "body": {"error": {"code": "E_UNKNOWN_COLUMN",
                    "didYouMean": ["title"],
                    "message": "Unknown column: titel",
                    "hint": "Did you mean: title?"}}}
```

Three things in that response come from three different commits:

- **`654c3cc`** — the suggestion, drawn from the MDL rather than the live database,
  which is what stops it leaking columns the caller can't see.
- **`8069cd6`** — `dry_plan` resolved all of that and **executed nothing**.
- **`c0b8128`** (way back in Move 2) — it's returned as a *tool result* with
  `isError`, not thrown. A thrown error becomes a JSON-RPC protocol error, which never
  enters the model's tool-result stream — the agent literally cannot read it and
  correct itself.

That last one is why an early, unglamorous commit matters: the correction loop only
closes because errors are data the model can see.

---

## Move 5 — Phase 3: make the claim testable (commits 45–54)

```
5629c42  golden query evaluation runner
0583cfa  CI gate on semantic changes
7be275c  persist successful execution memory
bb67520  hybrid memory retrieval
19774ad  serve labeled prior query context
f0cd73d  promote approved golden queries
573ab7d  core CLI
10882f4  guided and direct ask prompting
f8967fe  benchmark guided prompt accuracy
9ba8d9c  workflow skill discovery
```

Note the order: **`5629c42` (the eval) comes before `7be275c` (memory).** Building
retrieval first would mean tuning it with no feedback signal. "Improves accuracy" is
an unfalsifiable claim without a golden set, so the golden set came first and `0583cfa`
made CI fail on regression.

`bb67520` is hybrid on purpose — BM25 *and* vectors, fused. Pure vector search reliably
misses exact table-name matches; each half is tested separately for the case the other
one fails.

### Live: what "guided" actually buys

```bash
node dist/cli/index.js ask "How many PG-13 films are there?" --guided \
  --config demo/config.json --llm-command ./demo/fake-llm.sh >/dev/null
wc -c < /tmp/dsm-demo-prompt.txt ; grep '^##' /tmp/dsm-demo-prompt.txt

node dist/cli/index.js ask "How many PG-13 films are there?" --direct \
  --config demo/config.json --llm-command ./demo/fake-llm.sh >/dev/null
wc -c < /tmp/dsm-demo-prompt.txt
```

| Mode | Prompt | Sections |
|---|---|---|
| `--guided` | **117,130 bytes** | Question · Visible semantic schema · Project instructions · Approved query examples · Retrieved precedents |
| `--direct` | **31 bytes** | The question |

The LLM is a stub script, so this is deterministic and offline — the point is the
*context*, not a model's cleverness. Every section maps to a commit in Moves 4 and 5.

"Visible semantic schema" is the load-bearing word, and it's Move 6.

---

## Move 6 — Phase 4: two people, one question (commits 55–60)

```
8b92e6c  enforce out-of-band principals
1451121  principal policy engine
956e66f  inject row policies into query ASTs
2e8cf54  enforce column visibility policies
983f441  record policy decisions in audit logs
1bbc92a  map Mongo sources into MDL
```

`8b92e6c` comes first and it is the whole foundation: **the principal comes from server
config or the HTTP host, never from a tool argument.** If a model could assert its own
identity it would escalate by asking. There's a test that sends `principal: 'admin'` in
a tool call and asserts it is ignored.

### Live: the bypass that doesn't work

Two configs differing only in principal:

```bash
for p in one two; do
  node dist/cli/index.js query --source pagila \
    --sql "SELECT count(*) AS n FROM customer WHERE store_id = 2 OR 1=1" \
    --config demo/config.$p.json --json
done
```
```json
{"appliedPolicies":["limit:1000","read-only","store-one:hide-email","store-one:customer-store"],"rows":[{"n":"326"}]}
{"appliedPolicies":["limit:1000","read-only","store-two:customer-store"],"rows":[{"n":"273"}]}
```

Identical SQL. **326 and 273** — and they sum to 599, the whole table.

The SQL contains `OR 1=1`, the standard bypass. It fails because `956e66f` injects the
row filter **after** the agent's SQL is parsed, as a predicate on the syntax tree.
There is no string for the agent to escape out of.

### Live: column-level (`2e8cf54`)

```bash
node dist/cli/index.js query --source pagila --sql "SELECT * FROM customer" \
  --config demo/config.one.json --json | head -c 180        # no email field

node dist/cli/index.js query --source pagila --sql "SELECT email FROM customer" \
  --config demo/config.one.json --json                       # E_POLICY_DENIED

node dist/cli/index.js query --source pagila --sql "SELECT email FROM customer LIMIT 1" \
  --config demo/config.two.json --json                       # visible
```

`SELECT *` expands to visible columns only. Hidden means hidden *everywhere* —
`describe_model` doesn't list it, and it never appears in a `did_you_mean` suggestion.
A partial implementation is worse than none, because it reads as enforced.

`983f441` then records which policies were applied on every audit record, including the
denials. Access control you can't verify afterwards isn't access control.

---

## Move 7 — Phase 5: out of the terminal (commits 61–63)

```
879afbe  generate self-contained dashboards
0de9995  dashboard provider deployment
cf9f523  require human confirmation for deploys
```

Three commits, and the third is the one that matters. Deployment publishes data to the
public internet, so `cf9f523` makes a fresh human confirmation token mandatory and
unreachable from any agent tool call. There is deliberately no `--yes` an agent can
reach.

`879afbe` generates a single self-contained file — the tests scan the output for
`http://`, `https://`, `src=` and `fetch(` and fail if any appear.

---

## Why you should believe any of it

```bash
npm test        # 619 passed | 3 skipped
```

Four layers, each proving something the others can't:

| Layer | Proves |
|---|---|
| unit | pure logic — parsing, rewriting, policy resolution |
| integration | behaviour against real Pagila / Sakila / Mongo |
| e2e | the real MCP server over stdio |
| invariant | repo-wide structural rules |

**The e2e layer earned its cost twice.** Once it caught that `node-sql-parser` is
CommonJS: a named import worked under the test runner but crashed the built server on
startup. Four hundred unit tests were green while the shipped binary was broken.

**The invariant tests** enforce architecture rather than behaviour — nothing outside
`src/governance/` can mint a `QueryPlan`; no tool reaches the raw string-SQL path.
Those are properties of the whole tree that no unit test can observe.

**Three of my own tests were vacuous and got caught.** The clearest: I asserted a
password never appeared in an error response, and it passed. Then I checked what the
driver actually returns on a refused connection — `ECONNREFUSED`, no password anywhere.
The test passed whether or not redaction existed. The real leak is `MongoParseError`,
which echoes the entire connection URI. The test now asserts the leaky message
*arrived* and *was scrubbed*.

---

## What is deliberately not here

- **Apache DataFusion.** WrenAI's engine is Rust. This is TypeScript, and three sources
  each have a good planner. If cross-source joins become real: DuckDB, not DataFusion.
- **22+ connectors.** Postgres, MySQL, MongoDB. SQL Server is in the tree, unwired and
  untested — there is no container for it.
- **Auto-parameterising literals.** The agent authors whole statements and the AST
  round-trip already escapes them. Ceremony, not safety.
- **`instructions.md`.** The loader handles it and is tested, but the repo doesn't ship
  one, so guided prompts currently inject `(none)` for business rules. That is Tier-3
  content only a human can write — which is the same argument as `verified: false`.

---

## If you have 20 minutes

| Time | Move | Command |
|---|---|---|
| 0:00 | 0 — the starting point | *(talk, no commands)* |
| 2:00 | 3 — the floor | unbounded query, then the CTE refusal, then `tail audit.jsonl` |
| 7:00 | 4 — ground truth | `head demo/pagila.mdl.yml`, then `node demo/mcp-demo.mjs` |
| 12:00 | 6 — access control | the two-principal loop, then the three CLAC commands |
| 16:00 | — verification | `npm test`, the CommonJS story, the vacuous-test story |
| 18:00 | — scope and Q&A | the "deliberately not here" list |

Moves 3 and 6 are the ones to protect. Cut Move 5's prompt comparison first if you are
running long; cut the `dry_plan` moment last.

**Fallback if Docker misbehaves:** `npx vitest run tests/e2e tests/integration/rlac.test.ts`
and narrate the test names — they assert the same behaviour the live commands show.
