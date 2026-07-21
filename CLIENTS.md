# Using data-store-mcp with Claude, Codex, and Copilot

Setup for each MCP client. Every command here was run against a live install.

**The short version.** All three clients launch the same command:

```bash
node /abs/path/to/data-store-mcp/dist/cli/index.js serve \
  --config /abs/path/to/your/data-store-mcp.config.json \
  --env-file /abs/path/to/your/.env
```

Only the file you register it in differs.

> **Use absolute paths.** MCP clients spawn servers with an unpredictable working
> directory, and several provide no way to set one. A relative path is the single most
> common reason a server fails to start. This is not a style preference — it will bite.

---

## Before any client

**1. Build it.**

```bash
git clone <repo> && cd data-store-mcp
npm install
npm run build
```

**2. Write a config.** Anywhere you like — commonly the root of the project whose data
you're querying.

```json
{
  "principal": "local-analyst",
  "sources": [
    {
      "name": "app",
      "type": "postgres",
      "description": "Production read replica. Orders, customers, invoices.",
      "options": {
        "host": "127.0.0.1",
        "port": 5432,
        "user": "readonly_user",
        "password": "${DATASTORE_PASSWORD}",
        "database": "app"
      }
    }
  ],
  "semantic": { "path": "/abs/path/to/semantic" },
  "audit":    { "path": "/abs/path/to/.data-store-mcp/audit.jsonl" }
}
```

`principal`, `sources`, `semantic.path` and `audit.path` are all required. The schema
rejects unknown keys, so a typo is a startup error rather than a silent default — and
JSON has no comments, so don't add `$comment`.

Full key-by-key reference: [EXTENSION.md § Config reference](EXTENSION.md#config-reference).

**3. Put the password in `.env`, next to the config.**

```bash
DATASTORE_PASSWORD=your-password-here
```

Add `.env` to `.gitignore`. The config holds only a `${VAR}` reference, so it is safe to
commit; the secret lives in one untracked file that `--env-file` reads at startup.

**4. Check it before wiring up any client.**

```bash
node dist/cli/index.js serve \
  --config /abs/path/to/data-store-mcp.config.json \
  --env-file /abs/path/to/.env --check --json
```

```json
{"ok":true,"sources":["app"]}
```

`--check` validates the config, the semantic artifacts, the audit path, **and actually
connects to each source**, then exits. If this fails, no client will work — fix it here,
where the error is visible, rather than inside a tool call.

---

## Claude Code

### Project scope (recommended)

Create `.mcp.json` in the project root. It's shared with anyone who clones the repo.

```json
{
  "mcpServers": {
    "data-store": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/abs/path/to/data-store-mcp/dist/cli/index.js",
        "serve",
        "--config", "/abs/path/to/data-store-mcp.config.json",
        "--env-file", "/abs/path/to/.env"
      ]
    }
  }
}
```

No secrets in this file — `--env-file` supplies them — so it's safe to commit.

### Or with the CLI

```bash
claude mcp add data-store \
  -- node /abs/path/to/data-store-mcp/dist/cli/index.js serve \
     --config /abs/path/to/data-store-mcp.config.json \
     --env-file /abs/path/to/.env
```

Add `--scope user` to make it available in every project instead of just this one.

### Verify

```bash
claude mcp list
```

Then, in a session:

> Which data sources can you reach?

Claude calls `list_sources` and names your databases. If it instead starts writing shell
commands to find a database, it does **not** have the tools — see Troubleshooting.

---

## Codex CLI

Codex keeps MCP servers in `~/.codex/config.toml`.

```toml
[mcp_servers.data-store]
command = "node"
args = [
  "/abs/path/to/data-store-mcp/dist/cli/index.js",
  "serve",
  "--config", "/abs/path/to/data-store-mcp.config.json",
  "--env-file", "/abs/path/to/.env",
]
```

### Or with the CLI

```bash
codex mcp add data-store \
  -- node /abs/path/to/data-store-mcp/dist/cli/index.js serve \
     --config /abs/path/to/data-store-mcp.config.json \
     --env-file /abs/path/to/.env
```

`codex mcp add` also takes `--env KEY=VALUE`, but prefer `--env-file`: values passed on
the command line land in `~/.codex/config.toml` in plain text and in your shell history.

### Verify

```bash
codex mcp list          # add --json for the full resolved config
```

---

## Claude Desktop

Edit `claude_desktop_config.json`:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "data-store": {
      "command": "node",
      "args": [
        "/abs/path/to/data-store-mcp/dist/cli/index.js",
        "serve",
        "--config", "/abs/path/to/data-store-mcp.config.json",
        "--env-file", "/abs/path/to/.env"
      ]
    }
  }
}
```

Restart Claude Desktop fully — quit it, don't just close the window. The tools appear
under the connectors icon in the message box.

Claude Desktop launches servers from a GUI context that may not have your shell `PATH`,
so `"command": "node"` can fail there even when it works in a terminal. If it does, use
the full path from `which node`.

---

## VS Code / GitHub Copilot

Two options.

**The extension** ([EXTENSION.md](EXTENSION.md)) bundles the server, reads the workspace
`.env` for you, and gives you **Data Store MCP: Create Config File**. Best for sharing
with a team.

**Or configure it directly** in `.vscode/mcp.json`:

```json
{
  "servers": {
    "data-store": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/abs/path/to/data-store-mcp/dist/cli/index.js",
        "serve",
        "--config", "${workspaceFolder}/data-store-mcp.config.json",
        "--env-file", "${workspaceFolder}/.env"
      ]
    }
  }
}
```

VS Code expands `${workspaceFolder}`, so this one file works for everyone on the team.

**Copilot Chat must be in Agent mode** — MCP tools are not available in Ask mode. Check
the tools icon in the chat box for `data-store`.

---

## Confirming it actually works

Ask any of the three:

> How many PG-13 films are there?

The assistant should call `describe_model` then `query`, and answer with a number. Two
signs it's working rather than guessing:

- The response includes `"appliedLimit"` and `"appliedPolicies"` — governance is on.
- It used the exact stored value (`'PG-13'`, not `'PG13'`) because the semantic model
  carries the real column values.

Then try:

> Delete all the NC-17 films.

You should get `E_WRITE_FORBIDDEN`. If the assistant instead offers to write a script,
it isn't using the server.

---

## The six tools

| Tool | What the assistant uses it for |
|---|---|
| `list_sources` | Which databases exist, and what each is for |
| `describe_model` | Columns, types, and sampled real values for one model |
| `list_metrics` | Named business measures you've defined |
| `dry_plan` | Validate SQL — resolve names, apply policy — **without executing** |
| `query` | Run governed, read-only SQL |
| `search_context` | Previously successful queries, labelled as prior art |

Credentials appear in none of their responses.

---

## Troubleshooting

**The assistant starts writing shell commands to reach the database.** It doesn't have
the tools. This is the failure mode to recognise: with no MCP server, an agent will
install a database driver and hunt for the database itself — ungoverned, unaudited.
Check the client actually registered the server (`claude mcp list`, `codex mcp list`, or
the Copilot tools icon).

**"Connection closed" / server exits immediately.** Almost always a path problem. Run
the exact command from your client config, by hand, in a *different* directory:

```bash
cd /tmp && node /abs/path/.../dist/cli/index.js serve --config /abs/... --env-file /abs/... --check
```

If it works in the project directory but not `/tmp`, something is still relative.

**`Configuration references missing environment variable: X`.** `.env` doesn't define
`X`, or `--env-file` points somewhere wrong. Variables already set in your environment
win over the file, which is deliberate — an explicit export beats a file on disk.

**`Unrecognized key(s) in object`.** The schema is strict. Check spelling — `limit` vs
`limits` — and remove any comment keys.

**Tools listed but every query fails.** Run `--check`: it connects to each source and
reports which one is unreachable.

**Claude Desktop only: `spawn node ENOENT`.** GUI apps don't inherit your shell `PATH`.
Use the absolute path from `which node`.

---

## Sharing this with your team

Commit the config and `.mcp.json` / `.vscode/mcp.json`; never commit `.env`.

A colleague then needs: clone, `npm install && npm run build`, create their own `.env`,
and their client picks up the checked-in registration. The only per-person secret is the
password.

One caveat on absolute paths: they don't survive being shared. `.vscode/mcp.json` can use
`${workspaceFolder}`; for Claude Code and Codex, either install the server at a
predictable shared location or have each person adjust their own registration.
