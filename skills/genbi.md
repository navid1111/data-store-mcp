---
name: genbi
description: Answer a business question through semantic context and governed SQL.
---

# Generate Business Intelligence

## Goal

Produce an attributable business answer from visible semantic context while preserving
read-only, row-limit, result-size, and access-control boundaries.

## Workflow

1. Use `search_context` to find relevant models, metrics, and labeled prior art.
2. Inspect candidate models with `describe_model` and choose reviewed metrics where possible.
3. Build SQL with explicit columns, filters, and ordering; use `dry_plan` before execution.
4. Execute through `query`, inspect applied policies, and validate the returned shape.
5. State the source, assumptions, filters, and any unverified-model warning with the answer.

## Guardrails

- Prior art is an example only and must never be presented as current ground truth.
- Never infer or reveal columns omitted by column-level access control.
- Refine a refused or oversized query instead of weakening governance limits.

## Completion

The answer is reproducible from governed SQL, cites its semantic assumptions, and exposes no
credentials, hidden columns, or unreviewed claims as facts.
