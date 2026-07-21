# Shipping data-store-mcp as a VS Code Extension

How the extension works, how the config is designed, and how to build and publish it.

The scaffold in [`extension/`](extension/) is working code — it typechecks, bundles, and
the bundled server has been smoke-tested end to end.

---

## Why an extension at all

Without one, every user hand-writes `.vscode/mcp.json`, points it at a checkout of this
repo, installs Node dependencies, and works out where the config file goes. The
extension replaces that with: install, run one command, fill in two fields.

It also fixes the credential problem properly. The server needs a database password;
the assistant must never see one. The extension reads the workspace `.env` and passes
those values **directly to the spawned process** — they never enter a tool response,
never reach the model, and are never persisted by the extension.

---

## How it works

```
VS Code starts
  └─ extension activates (onStartupFinished)
      └─ registers an McpServerDefinitionProvider
          ├─ provideMcpServerDefinitions()   ← reads config path + .env
          │    └─ McpStdioServerDefinition( node, [server.cjs], env, … )
          └─ resolveMcpServerDefinition()    ← runs just before spawn
               └─ refuses to start if a ${VAR} has no value
```

Three parts of the API do the work ([src/extension.ts](extension/src/extension.ts)):

| API | Role here |
|---|---|
| `contributes.mcpServerDefinitionProviders` | Declares the provider so VS Code knows it exists before activation |
| `vscode.lm.registerMcpServerDefinitionProvider(id, …)` | Supplies the actual server definition |
| `onDidChangeMcpServerDefinitions` | Fired when the config or `.env` changes, so VS Code restarts the server with fresh values |

**`resolveMcpServerDefinition` is where the good error messages come from.** It runs
immediately before spawn. If the config references `${DATASTORE_PASSWORD}` and `.env`
doesn't define it, the extension returns `undefined` — the server never starts — and
shows a notification naming the missing variable with buttons to open either file.

The alternative is letting the server boot and fail on the first query, *inside a tool
call*, where the user sees "the assistant couldn't answer" and nothing else.

> **API note:** `McpStdioServerDefinition`'s constructor is **positional** —
> `(label, command, args?, env?, version?)` — and `cwd` is a settable property, not a
> constructor argument. Some documentation samples show an options object; that doesn't
> compile. `npx tsc --noEmit` catches it.

---

## The credential design

Three files, three jobs:

| File | Contains | Committed? |
|---|---|---|
| `data-store-mcp.config.json` | Structure: hosts, ports, database names, limits | **Yes** |
| `.env` | Secrets only: passwords, tokens | **Never** |
| `.gitignore` | Gets `.env` added automatically on config creation | Yes |

The config refers to secrets by name:

```json
"password": "${DATASTORE_PASSWORD}"
```

`.env` supplies the value:

```bash
DATASTORE_PASSWORD=hunter2
```

This split is why the config is safe to commit from the moment it's created, rather
than after somebody remembers to scrub it. The generated template ships with the
`${VAR}` reference already in place, so the natural path is the safe one.

**Three implementation details worth knowing:**

`.env` is parsed into a plain object, never loaded with `dotenv.config()`. That function
mutates `process.env` in the *extension host* — a process shared with every other
extension you have installed. See [src/env.ts](extension/src/env.ts).

Real environment variables still work. `missingVariables()` checks `process.env` as
well as `.env`, so CI and shells that export credentials directly keep working without
a `.env` file.

Values are never written to extension state or settings sync. They are read at spawn
time and handed to one child process.

---

## Config reference

### Minimum viable config

Four keys are mandatory — `principal`, `sources`, `semantic.path`, `audit.path`. The
schema is `.strict()`, so a missing *or* misspelled key is a startup error rather than a
silent default.

```json
{
  "principal": "local-analyst",
  "sources": [
    {
      "name": "main",
      "type": "postgres",
      "options": {
        "host": "127.0.0.1", "port": 5432,
        "user": "readonly_user", "password": "${DATASTORE_PASSWORD}",
        "database": "postgres"
      }
    }
  ],
  "semantic": { "path": "./semantic" },
  "audit":    { "path": "./.data-store-mcp/audit.jsonl" }
}
```

> **The config allows no comments.** JSON has no comment syntax and the schema rejects
> unrecognised keys — including `$comment`. That strictness is deliberate: it turns
> `"limit"` instead of `"limits"` into an immediate error instead of a silently ignored
> setting.

### Top level

| Key | Required | Default | What it does |
|---|---|---|---|
| `principal` | ✅ | — | Who is asking. Selects the policy under `policies.principals`. **Never supplied by the assistant** — if a model could name its own principal it would escalate by asking. |
| `sources` | ✅ | — | Databases to expose. At least one. |
| `semantic.path` | ✅ | — | Directory of MDL YAML files. The directory may be empty — `describe_model` and `list_metrics` then return nothing — but the key itself is required. |
| `audit.path` | ✅ | — | JSONL audit log. Required: every execution is recorded, so there is no "off". |
| `memory.path` | | *unset* | Query memory index. **Requires the native LanceDB package**, so the generated template omits it — see [Shipping constraints](#shipping-constraints). Unset, `search_context` returns `{"precedents": []}` rather than failing. |
| `limits.timeoutMs` | | `30000` | Cancelled at the database, not client-side. |
| `limits.maxResultBytes` | | `10485760` | Cap on serialized result size, enforced while streaming. |
| `policies` | | *none* | Row and column rules. See below. |

### A source

```json
{
  "name": "analytics",
  "type": "postgres",
  "description": "Read-only analytics warehouse",
  "options": { "host": "…", "port": 5432, "user": "…", "password": "${VAR}", "database": "…" }
}
```

| Key | Notes |
|---|---|
| `name` | How the assistant refers to it. Keep it short and meaningful. |
| `type` | `postgres`, `mysql`, or `mongodb`. |
| `description` | **The assistant reads this.** "Read-only analytics warehouse, refreshed hourly" is worth writing; "db1" is not. |
| `options` | Postgres/MySQL take `host`/`port`/`user`/`password`/`database`. MongoDB takes `uri` and `database`. |

### Policies

Optional, and only needed when different people should see different data.

```json
"policies": {
  "roles": {
    "support": {
      "rowFilters": [
        { "name": "own-region", "model": "customer",
          "column": "region_id", "operator": "eq", "value": 3 }
      ],
      "hiddenColumns": [
        { "name": "hide-pii", "model": "customer", "columns": ["email", "phone"] }
      ]
    }
  },
  "principals": {
    "support-agent": { "roles": ["support"] }
  }
}
```

- **`rowFilters`** are injected into the query's syntax tree *after* the assistant's SQL
  is parsed. Appending `OR 1=1` doesn't work — there's no string to escape out of.
- **`hiddenColumns`** are hidden everywhere: `SELECT *` expands to visible columns only,
  naming one directly returns `E_POLICY_DENIED`, `describe_model` omits it, and it never
  appears in a `didYouMean` suggestion.
- **An unknown principal gets the most restrictive policy, not the loosest.** Fails closed.

### Paths

Relative paths resolve against the **workspace root** — the extension sets the server's
`cwd` to the first workspace folder. `./semantic` means `<workspace>/semantic`.

---

## Building it

```bash
cd extension
npm install
npm run build          # bundles the server, then the extension
```

`npm run build` does two things:

**1. `scripts/bundle-server.mjs`** — esbuild bundles `../src/server.ts` into a single
`dist/server/server.cjs` (~7.4 MB). All the database drivers are pure JavaScript, so
this needs no native modules.

**2. esbuild bundles `src/extension.ts`** into `dist/extension.js` (~13 KB), with
`vscode` external because the host provides it.

**Verify the bundle actually runs** before packaging — this is the step that catches
ESM/CommonJS interop problems that unit tests miss:

```bash
cd ..
DATA_STORE_MCP_CONFIG=demo/config.json node extension/dist/server/server.cjs
# should print: data-store-mcp MCP server running on stdio
```

### Testing the extension

```bash
code --extensionDevelopmentPath=$(pwd)/extension
```

In the new window: open a folder, run **Data Store MCP: Create Config File**, fill in
your database, put the password in `.env`, then open Copilot Chat in **Agent** mode and
check the tools picker.

Run **Data Store MCP: Check Setup** to have it report every configuration problem at
once instead of one per restart.

---

## Shipping constraints

**The one real problem: LanceDB.** The query-memory feature (`search_context`) uses
LanceDB, which ships a prebuilt native binary — **155 MB for a single platform**, and a
different one per OS/architecture. Bundling it would mean five platform-specific VSIXs
of ~160 MB each.

The bundled server loads LanceDB lazily. If `memory.path` is unset, it is never
required, and `search_context` returns `{"precedents": []}` rather than failing. This
is verified, not assumed.

That gives three options:

| Option | VSIX | `search_context` | Verdict |
|---|---|---|---|
| **Ship without memory** | ~8 MB, one universal build | Returns empty | **Recommended for v1** |
| Platform-specific builds | ~160 MB × 5 targets | Works | Only if memory is a headline feature |
| Optional post-install | ~8 MB + user runs `npm i @lancedb/lancedb` | Works after opt-in | Good v2 |

For option 1, delete the `@lancedb` copy step from `scripts/bundle-server.mjs` and
document that `memory.path` requires a separate install. For option 2, use
`vsce package --target linux-x64` (and `darwin-arm64`, `win32-x64`, …) with the matching
binary present.

---

## Publishing

**1. Create a publisher** at <https://marketplace.visualstudio.com/manage>. You need a
Microsoft account and an Azure DevOps organization for the token.

**2. Create a Personal Access Token** in Azure DevOps with **Marketplace → Manage**
scope, for *all accessible organizations*. Tokens scoped to a single org silently fail
to publish.

**3. Set the real values** in `extension/package.json`:

```json
"publisher": "your-publisher-id",
"repository": { "type": "git", "url": "https://github.com/you/data-store-mcp" }
```

**4. Package and inspect before you publish:**

```bash
npx vsce package
npx vsce ls              # exactly what will ship — check no .env, no dumps, no node_modules
```

[`.vscodeignore`](extension/.vscodeignore) ships `dist/` only. Confirm with `vsce ls`
rather than trusting it; an accidentally-published secret can't be unpublished from
people's machines.

**5. Publish:**

```bash
npx vsce login your-publisher-id
npx vsce publish              # or: vsce publish minor
```

### Before the first publish

- [ ] `engines.vscode` is `^1.101.0` or higher — `registerMcpServerDefinitionProvider`
      became stable in 1.101 and older hosts will fail to activate
- [ ] `README.md` in `extension/` — it becomes the marketplace page
- [ ] `icon` (128×128 PNG) and `LICENSE`
- [ ] `vsce ls` shows no secrets
- [ ] Installed the packaged `.vsix` locally and completed the flow end to end
- [ ] The extension does *not* declare `enableProposedApi` — extensions using proposed
      APIs cannot be published

---

## Design decisions worth keeping

**Activation is `onStartupFinished`, not `*`.** The provider must be registered before
the user opens Copilot, but there's no reason to be in the critical startup path.

**No config means no server.** If there's no config file, `provideMcpServerDefinitions`
returns an empty array and logs to the output channel. It does not pop a notification —
an extension that nags on every window open gets uninstalled.

**Both files are watched.** Editing `.env` or the config fires
`onDidChangeMcpServerDefinitions`, so VS Code restarts the server. No manual reload
after a password change.

**Setup problems are reported together.** `Check Setup` lists every issue at once —
missing config, malformed JSON, missing variables, absent `.env` — because finding them
one restart at a time is miserable.

---

## What's left to do

The scaffold is functional but not finished:

- **No tests.** `parseEnv` and `referencedVariables` are pure functions and should have
  unit tests; the activation path wants an integration test via
  `@vscode/test-electron`.
- **No icon or marketplace README.**
- **Single-folder workspaces only.** It reads `workspaceFolders[0]`. Multi-root support
  means one server definition per folder that has a config.
- **The LanceDB decision is unmade** — the bundler currently copies it, which produces a
  163 MB output directory. Pick an option from the table above before packaging.
- **No `nodePath` validation.** If `node` isn't on `PATH`, the failure surfaces as a
  server that won't start rather than a clear message.
