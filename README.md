# data-store-mcp

A TypeScript Model Context Protocol (MCP) server that gives AI assistants structured, inspectable access to application data.

`data-store-mcp` sits between an MCP client and one or more databases, exposing safe tool-shaped operations such as connect, inspect, and query. The goal is simple: let an assistant work with real schema and real records instead of guessing from prompt context alone.

## Why this project matters

Most AI workflows break the moment an assistant needs live data. This project closes that gap by packaging database access behind a consistent MCP interface.

What it demonstrates:
- MCP server design with a real developer use case
- reusable adapter architecture across SQL and NoSQL backends
- schema-first assistant workflows (`inspect` before `query`)
- typed tool contracts and validation with Zod
- practical AI tooling for internal analytics, debugging, and ops support

## Highlights

- MCP stdio server built with `@modelcontextprotocol/sdk`
- tool registry for connect / inspect / query workflows
- validation layer for tool inputs and connection payloads
- backend adapters for PostgreSQL, MySQL, and MongoDB in the active flow
- SQL Server adapter code included for broader multi-database support
- clean repository structure for extending the server with more tools

## Architecture overview

```mermaid
flowchart LR
    A[MCP Client
Claude / VS Code / Agent] --> B[stdio MCP Server
src/server.ts]
    B --> C[Tool Registry
src/mcp/tools/index.ts]
    C --> D[connect_database]
    C --> E[inspect_database]
    C --> F[query_database]
    D --> G[Connection Manager]
    E --> G
    F --> G
    G --> H[PostgreSQL Adapter]
    G --> I[MySQL Adapter]
    G --> J[MongoDB Adapter]
    G --> K[SQL Server Adapter]
```

## Typical assistant workflow

```mermaid
sequenceDiagram
    participant U as User
    participant C as MCP Client
    participant S as data-store-mcp
    participant DB as Database

    U->>C: "Check customer churn by plan"
    C->>S: inspect_database(connectionId)
    S->>DB: inspect schema
    DB-->>S: tables, columns, relations
    S-->>C: schema summary
    C->>S: query_database(connectionId, query)
    S->>DB: run query
    DB-->>S: rows
    S-->>C: machine-readable result
```

## Exposed MCP tools

### `connect_database`
Creates a reusable connection handle for a supported backend.

Used for:
- validating credentials and connection options
- selecting the correct adapter
- storing a connection for later inspect/query calls

### `inspect_database`
Lets an assistant inspect tables, collections, columns, and relationships before it generates a query.

Used for:
- reducing hallucinated schema references
- mapping unknown databases quickly
- grounding downstream analysis tasks

### `query_database`
Executes SQL queries or structured MongoDB query payloads.

Used for:
- analytics questions
- debugging live application data
- powering internal AI workflows that need trustworthy data access

## Example setup

Install and build:

```bash
npm install
npm run build
```

Start the server:

```bash
npm start
```

Because the server runs on stdio, it is typically launched by an MCP client rather than manually used in a shell.

## Example MCP client configuration

```json
{
  "mcpServers": {
    "data-store-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/data-store-mcp/dist/server.js"]
    }
  }
}
```

## Example usage flow

1. Start the MCP client with the server configured.
2. Ask the client to inspect a database.
3. Use the returned schema to drive a targeted query.

Example prompt to an assistant:

```text
Connect to the analytics database, inspect the customer and subscription tables,
and then show me the number of active customers by pricing plan.
```

## Repository structure

```text
data-store-mcp/
├── src/
│   ├── server.ts
│   ├── database-source.ts
│   ├── postgres.ts
│   ├── mysql.ts
│   ├── mongodb.ts
│   ├── mssql.ts
│   └── mcp/
│       └── tools/
│           ├── index.ts
│           ├── connect.ts
│           ├── inspector.ts
│           └── query.ts
├── test_server_e2e.ts
├── verify_schema.ts
└── package.json
```

## Tech stack

- TypeScript
- Node.js
- Model Context Protocol SDK
- Zod
- PostgreSQL / MySQL / MongoDB / MSSQL drivers

## Good fit for

- AI-native internal tooling
- assistant-enabled data exploration
- database-aware coding agents
- analytics copilots and support workflows

## Status

This is a strong portfolio project for AI tooling and backend platform roles because it shows protocol integration, typed backend design, and practical developer-product thinking in one repo.
