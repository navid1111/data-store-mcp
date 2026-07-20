---
name: onboarding
description: Configure data-store-mcp and verify a safe first query.
---

# Onboarding

## Goal

Connect an administrator-configured source, inspect its governed surface, and verify the
installation without exposing credentials to an agent.

## Workflow

1. Copy `data-store-mcp.config.example.json` and keep credentials in environment variables.
2. Run `dsm serve --config <path> --check --json` to validate semantic files, audit storage,
   memory, and source connectivity.
3. Start the MCP server with `dsm serve --config <path>`.
4. Call `list_sources`, then `describe_model`, before attempting a query.
5. Run one bounded, read-only query and confirm an audit record was appended.

## Guardrails

- Never put passwords, connection URIs, or principals in prompts or MCP tool arguments.
- Treat bootstrapped semantic entities as unverified until a human reviews them.
- Do not bypass `dry_plan` or the governed `query` boundary with a raw driver call.

## Completion

The configured source is discoverable, a read-only query succeeds, writes are refused, and
the audit log attributes the attempt to the configured principal.
