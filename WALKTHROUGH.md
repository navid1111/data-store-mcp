# data-store-mcp — Walkthrough

From an empty terminal to asking GitHub Copilot *"How many PG-13 movie titles are
there?"* and getting a real, governed answer.

Every transcript below is real output captured from a running server.

---

## What this is

You point it at your databases. It hands your AI assistant a **safe, described** view
of them: the assistant learns what the tables mean, can't run anything destructive,
can't return unbounded results, and only sees the data the person asking is allowed to
see.

Without it, an assistant with a database connection guesses at column names and has
nothing stopping a `DELETE`. With it, guessing is replaced by a schema it can read, and
"nothing stopping it" is replaced by a gate every query goes through.

---

## Step 1 — Get databases running

If you already have a Postgres or MySQL you want to use, skip to Step 2.

For a first run, the repo ships two well-known sample databases — Pagila (Postgres) and
Sakila (MySQL), both DVD-rental datasets with ~1,000 films:

```bash
npm install
npm run db:up      # downloads the dumps, starts containers, waits for data to load
npm run build
```

`db:up` takes a couple of minutes the first time. It waits until the data is actually
queryable, not just until the container is up.

**Check it worked:**

```bash
docker compose ps
```
```
postgres   running (healthy)     0.0.0.0:55432->5432/tcp
mysql      running (healthy)     0.0.0.0:53306->3306/tcp
mongo      running (healthy)     0.0.0.0:57017->27017/tcp
```

---

## Step 2 — Tell the server about your databases

Create a config file. This is the **only** place credentials live — they never travel
through the AI assistant.

`demo/config.json`:

```json
{
  "principal": "demo-analyst",
  "semantic": { "path": "./semantic" },
  "audit":    { "path": "./demo/audit.jsonl" },
  "limits":   { "maxResultBytes": 10485760, "timeoutMs": 30000 },
  "sources": [
    {
      "name": "pagila",
      "type": "postgres",
      "description": "Pagila DVD-rental sample database",
      "options": {
        "host": "127.0.0.1", "port": 55432,
        "user": "postgres", "password": "dsm_test_pw",
        "database": "pagila"
      }
    }
  ]
}
```

For a real database use `"password": "${MY_DB_PASSWORD}"` and export the variable — the
config reads it from the environment.

> **Use a read-only database user.** The server refuses writes on its own, but defence
> in depth costs nothing here.

**Check it worked:**

```bash
node dist/cli/index.js query --source pagila --sql "SELECT 1 AS ok" \
  --config demo/config.json --json
```
```json
{"source":"pagila","appliedLimit":1000,"appliedPolicies":["limit:1000","read-only"],"rows":[{"ok":1}]}
```

---

## Step 3 — Describe your data (one command)

The assistant shouldn't have to guess what your tables mean. `mdl bootstrap` reads the
schema *and samples the data* to produce a description file:

```bash
node dist/cli/index.js mdl bootstrap \
  --source pagila --output semantic/pagila.mdl.yml --config demo/config.json
```
```json
{ "modelCount": 22 }
```

Open the result and look at the `rating` column:

```yaml
- name: rating
  description: Column rating on film.
  provenance: introspection
  verified: false
  dataType: mpaa_rating
  profile:
    distinctCount: 5
    topValues:
      - { value: "PG-13", count: 223 }
      - { value: "NC-17", count: 210 }
      - { value: "R",     count: 195 }
      - { value: "PG",    count: 194 }
      - { value: "G",     count: 178 }
```

**This block is why the assistant won't guess.** Ask a human "find the PG-13 films" and
they'd have to know whether the database stores `PG-13`, `PG13`, or `pg_13`. The
assistant doesn't guess either — it reads the actual values.

Two fields to notice:

- `provenance: introspection` — where this came from.
- `verified: false` — **a machine wrote this, no human has checked it.**

That second flag is deliberate. A generated description that *looks* authoritative but
is wrong is worse than no description, because your assistant will trust it. You edit
the descriptions, review them like code, and flip the flag. Until then everything
downstream knows the text is unverified.

---

## Step 4 — Connect it to GitHub Copilot

Create `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "data-store": {
      "type": "stdio",
      "command": "node",
      "args": ["dist/server.js"],
      "cwd": "/absolute/path/to/data-store-mcp",
      "env": { "DATA_STORE_MCP_CONFIG": "demo/config.json" }
    }
  }
}
```

Then in VS Code:

1. Open Copilot Chat and switch it to **Agent** mode (MCP tools are only available in
   agent mode).
2. Click the **tools** icon in the chat box.
3. You should see `data-store` with six tools:
   `list_sources`, `describe_model`, `list_metrics`, `dry_plan`, `query`, `search_context`.

**Check it worked** — ask Copilot:

> What data sources do you have access to?

It calls `list_sources` and gets back:

```json
{"sources":[
  {"name":"pagila","type":"postgres","description":"Pagila DVD-rental sample database"},
  {"name":"sakila","type":"mysql","description":"Sakila DVD-rental sample database"}
]}
```

Notice what is *not* in that response: no host, no user, no password. Copilot knows the
sources exist and what they're for. It cannot see how to connect to them.

---

## Step 5 — Ask your first question

> **You:** How many PG-13 movie titles are there?

Copilot works through three tool calls.

**1. It looks up the model** — `describe_model { "name": "film" }`

```json
{ "name": "rating", "dataType": "mpaa_rating",
  "profile": { "distinctCount": 5,
               "topValues": [ { "value": "PG-13", "count": 223 }, ... ] } }
```

**2. It writes SQL** using the real value it just read — `'PG-13'`, not a guess.

**3. It runs it** — `query { "connectionId": "pagila", "sql": "SELECT count(*) AS n FROM film WHERE rating = 'PG-13'" }`

```json
{
  "connectionId": "pagila",
  "type": "postgres",
  "appliedLimit": 1000,
  "appliedPolicies": ["limit:1000", "read-only"],
  "results": [ { "n": "223" } ]
}
```

> **Copilot:** There are **223** PG-13 films.

Two things happened that you didn't ask for. `appliedLimit: 1000` — a row cap was added
automatically. `appliedPolicies` — the response states what rules were enforced, so the
assistant knows whether it saw everything.

And the answer matches the profile it read in step 1. It didn't have to guess the
spelling, and it didn't have to fetch 1,000 rows to count them.

---

## Step 6 — Now try to break it

This is the part worth trying yourself.

### Ask for something big

> **You:** Show me every film with its description and special features.

```json
{ "appliedLimit": 1000, "appliedPolicies": ["limit:1000","read-only"], "results": [ ...1000 rows ] }
```

You get 1,000 rows, not the whole table, and the response says so. Without this, a
`SELECT *` on a large table floods the assistant's context window and the conversation
falls over.

### Ask it to change something

> **You:** Delete all the NC-17 films.

```json
{ "error": {
    "code": "E_WRITE_FORBIDDEN",
    "statementType": "delete",
    "message": "DELETE is not permitted; this connection is read-only.",
    "hint": "Only SELECT statements and read-only CTEs are allowed." } }
```

Copilot tells you it can't. The refusal is *structured* — it has a code and a hint — so
the assistant understands why and doesn't retry the same thing five times.

This holds for cleverer attempts too. A write hidden inside a `WITH` clause still looks
like a `SELECT` at the top level, and is still refused:

```sql
WITH x AS (INSERT INTO film (title) VALUES ('x') RETURNING *) SELECT * FROM x
```

### Use a column that doesn't exist

> **You:** List the film titels rated G.

```json
{ "error": {
    "code": "E_UNKNOWN_COLUMN",
    "message": "Unknown column: titel",
    "didYouMean": ["title"],
    "hint": "Did you mean: title?" } }
```

Copilot reads `didYouMean`, corrects itself to `title`, and re-runs — usually without
telling you anything went wrong. That's the difference between an error your assistant
can act on and an opaque database exception it just relays back to you.

### Ask it to check before running

> **You:** Validate this query but don't run it: `SELECT count(*) FROM film WHERE rating = 'PG-13'`

`dry_plan` returns the SQL that *would* run, with the limit already added:

```json
{ "connectionId": "pagila",
  "sql": "SELECT COUNT(*) AS \"n\" FROM \"film\" WHERE rating = 'PG-13' LIMIT 1000" }
```

Nothing touched the database. Useful when the assistant is drafting something expensive
and you want to see the plan first.

### Ask something slow

A runaway query is cancelled at the database after 30 seconds (configurable) and comes
back as `E_TIMEOUT`. The query is genuinely killed on the server, not just abandoned by
the client — so it stops consuming resources.

---

## Step 7 — Teach it your business language

So far the assistant knows your *schema*. It doesn't know your *business*.

Two files, both plain text in your repo, both reviewed like code.

**`instructions.md`** — the rules a new analyst would need:

```markdown
# Business rules

- "Active customer" means `customer.active = 1`. Never count inactive customers
  in revenue figures.
- Revenue always comes from `payment.amount`, never `film.rental_rate` — the
  latter is a list price, not what was actually paid.
- Exclude staff rentals (`staff_id = 1`) from customer-facing reports.
```

**`queries.yml`** — questions with approved SQL:

```yaml
queries:
  - question: First three film identifiers
    sql: SELECT film_id FROM film WHERE film_id IN (1, 2, 3) ORDER BY film_id
    expected:
      - film_id: 1
      - film_id: 2
      - film_id: 3
```

These do double duty. They give the assistant worked examples, and they're a **test
suite for your data model**:

```bash
npx vitest run tests/integration/golden-eval.test.ts
```

Every approved query runs against the real database and its results are compared. If
someone renames a column, this fails. It runs in CI on every change to your semantic
files.

---

## Step 8 — Give different people different answers

Everything so far assumed one user. Real deployments don't work that way.

Add policies to your config:

```json
"policies": {
  "roles": {
    "store-one": {
      "rowFilters":    [{ "name": "customer-store", "model": "customer",
                          "column": "store_id", "operator": "eq", "value": 1 }],
      "hiddenColumns": [{ "name": "hide-email", "model": "customer",
                          "columns": ["email"] }]
    },
    "store-two": {
      "rowFilters":    [{ "name": "customer-store", "model": "customer",
                          "column": "store_id", "operator": "eq", "value": 2 }]
    }
  },
  "principals": {
    "analyst-one": { "roles": ["store-one"] },
    "analyst-two": { "roles": ["store-two"] }
  }
}
```

Now the same question gives different answers:

```bash
for p in one two; do
  node dist/cli/index.js query --source pagila \
    --sql "SELECT count(*) AS n FROM customer" --config demo/config.$p.json --json
done
```
```json
{"appliedPolicies":["limit:1000","read-only","store-one:hide-email","store-one:customer-store"],"rows":[{"n":"326"}]}
{"appliedPolicies":["limit:1000","read-only","store-two:customer-store"],"rows":[{"n":"273"}]}
```

326 and 273 — 599 customers total, split by store. Neither analyst sees the other's.

**The filter can't be talked around.** Try it with a classic bypass:

```sql
SELECT count(*) AS n FROM customer WHERE store_id = 2 OR 1=1
```

Still 326 and 273. The filter is added *after* the SQL is parsed, as a condition on the
query's structure — there's no text for the assistant to escape out of, deliberately or
otherwise.

**Hidden columns are hidden everywhere.** For `analyst-one`:

```bash
# SELECT * quietly returns only the visible columns — no email
node dist/cli/index.js query --source pagila --sql "SELECT * FROM customer" \
  --config demo/config.one.json --json

# Asking for it directly is refused
node dist/cli/index.js query --source pagila --sql "SELECT email FROM customer" \
  --config demo/config.one.json --json
```
```json
{"error":{"code":"E_POLICY_DENIED","policy":"store-one:hide-email"}}
```

`describe_model` won't list it either, and it never shows up in a `didYouMean`
suggestion. The assistant can't ask for what it was never shown.

> **Where does the identity come from?** Server config, or your app when it runs the
> HTTP server. **Never from the assistant.** If the model could state its own role, it
> could grant itself one just by asking.

---

## Step 9 — Check what happened

Every query writes one line to the audit log — including the ones that were refused:

```bash
tail -3 demo/audit.jsonl
```
```json
{"timestamp":"…","principal":"demo-analyst","source":"pagila","sql":"DROP TABLE film",
 "appliedPolicies":["read-only"],"rowCount":0,"outcome":"denied",
 "errorCode":"E_WRITE_FORBIDDEN","denialReason":"DROP is not permitted; …"}
{"timestamp":"…","principal":"demo-analyst","sql":"SELECT title FROM \"film\" LIMIT 1000",
 "appliedPolicies":["limit:1000","read-only"],"rowCount":1000,"outcome":"success"}
```

Who asked, what ran, which rules applied, how many rows came back, and whether it was
allowed. Passwords are stripped before anything is written.

---

## Step 10 — Turn an answer into something shareable

```bash
node dist/cli/index.js dashboard deploy --file report.html \
  --provider vercel --endpoint <url> --token-env VERCEL_TOKEN
```

The generated dashboard is a **single self-contained file** — no external scripts, no
calls home, data embedded.

Deploying requires a fresh human confirmation token, and there is no flag the assistant
can pass to skip it. Publishing your data to the public internet is not something an
agent gets to decide on its own.

---

## Other things you can ask

Once it's wired up, these all work in normal conversation:

| You say | What happens |
|---|---|
| *"What tables are there?"* | `list_sources` + `describe_model` |
| *"What does the `rental` table mean?"* | `describe_model` — descriptions, types, sample values |
| *"What metrics are defined?"* | `list_metrics` — your named business measures |
| *"Have we asked anything like this before?"* | `search_context` — past successful queries, labelled as prior art rather than truth |
| *"Compare rentals across both databases"* | Runs against `pagila` and `sakila` separately |

---

## Using it without Copilot

Everything is available from the CLI:

```bash
node dist/cli/index.js query --source pagila --sql "SELECT …" --config demo/config.json
node dist/cli/index.js mdl lint --source pagila --file semantic/pagila.mdl.yml --config demo/config.json
node dist/cli/index.js ask "How many PG-13 films?" --guided --config demo/config.json
node dist/cli/index.js skills get onboarding
```

`mdl lint` is worth scheduling — it re-checks your description file against the live
database and reports drift when someone drops a column or changes a type.

`ask --guided` needs an LLM command (`--llm-command`, an executable that reads a prompt
on stdin). It's for scripted use; with Copilot you just talk to Copilot.

---

## What it deliberately won't do

- **Write to your database.** Ever. Not configurable.
- **Show the assistant your credentials.** They live in config and never enter a tool
  response.
- **Let the assistant claim an identity.** Roles come from your config or your app.
- **Deploy without a human.** No agent-reachable override.
- **Trust generated descriptions.** Everything machine-written stays `verified: false`
  until a person reviews it.

---

## Troubleshooting

**Copilot doesn't list the tools.** Make sure chat is in **Agent** mode; MCP tools are
hidden in Ask mode. Then check the server starts on its own:
`DATA_STORE_MCP_CONFIG=demo/config.json node dist/server.js` — it should print
`data-store-mcp MCP server running on stdio` and wait.

**`DATA_STORE_MCP_CONFIG must point to a JSON configuration file`.** The env var is
missing or the path is wrong. It's resolved relative to `cwd` in `mcp.json`, so use an
absolute path there.

**Every query returns `E_POLICY_DENIED`.** Your `principal` doesn't match any entry
under `policies.principals`. Unknown principals get the most restrictive policy, not
the loosest — it fails closed.

**`mdl lint` reports drift.** Someone changed the schema. Re-run `mdl bootstrap` into a
new file and diff the two before overwriting, so you don't lose descriptions you wrote
by hand.

**Containers healthy but queries fail.** `npm run db:reset` re-seeds from scratch.

---

## Where to read more

- [spec.md](spec.md) — what it does and why, including what was ruled out
- [architecture.md](architecture.md) — how the pieces fit
- [test.md](test.md) — the pass/fail criteria behind every feature above
- [DEMO.md](DEMO.md) — the same system explained through its commit history
