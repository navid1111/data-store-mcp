---
name: enrich-context
description: Build and review semantic context from live schema and query evidence.
---

# Enrich Context

## Goal

Turn database structure and observed query evidence into reviewable MDL, business rules,
and approved query examples without laundering inferred meaning into verified truth.

## Workflow

1. Run `dsm mdl bootstrap --source <name> --output semantic/<name>.yml`.
2. Review model, column, relationship, and metric descriptions; keep inferred content marked
   unverified until a human confirms it.
3. Add business definitions and non-schema rules to `instructions.md`.
4. Promote only explicitly approved successful queries into `queries.yml`.
5. Run `dsm mdl lint --source <name> --file semantic/<name>.yml` and the golden evaluation.

## Guardrails

- Profiles and query logs are evidence, not ground truth.
- Never silently promote prior executions or LLM drafts into approved artifacts.
- Keep stable YAML ordering so reviewers can see the semantic change clearly.

## Completion

MDL matches the live schema, descriptions have human-reviewable provenance, instructions
are versioned, and approved examples pass their recorded golden expectations.
