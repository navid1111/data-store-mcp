/**
 * The config written by "Data Store MCP: Create Config File".
 *
 * Two properties matter for a first run:
 *  - It is *complete* — every field the server needs is present, so the only
 *    edits required are the connection details.
 *  - It contains **no secrets**. The password is a `${VAR}` reference resolved
 *    from .env, so the file this creates is safe to commit from the moment it
 *    exists rather than after someone remembers to scrub it.
 */

export const DEFAULT_ENV_TEMPLATE = `# Data Store MCP credentials — DO NOT COMMIT
# Referenced from data-store-mcp.config.json as \${DATASTORE_PASSWORD}.
DATASTORE_PASSWORD=change-me
`;

/**
 * No comment key is emitted. The config schema is strict — it rejects any key
 * it does not recognise, which is what catches `limit` vs `limits` — and JSON
 * has no comment syntax, so there is nowhere to put a doc pointer without
 * either weakening that check or writing a file the server would refuse.
 * The link lives in the post-creation notification and the setting description
 * instead.
 */
export function defaultConfig(): string {
    return `{
  "principal": "local-analyst",

  "sources": [
    {
      "name": "main",
      "type": "postgres",
      "description": "What this database is for. The assistant reads this.",
      "options": {
        "host": "127.0.0.1",
        "port": 5432,
        "user": "readonly_user",
        "password": "\${DATASTORE_PASSWORD}",
        "database": "postgres"
      }
    }
  ],

  "semantic": { "path": "./semantic" },
  "audit":    { "path": "./.data-store-mcp/audit.jsonl" },

  "limits": {
    "timeoutMs": 30000,
    "maxResultBytes": 10485760
  }
}
`;
}

/** Appended to .gitignore when the config is created. */
export const GITIGNORE_ENTRIES = [
    '.env',
    '.data-store-mcp/',
];
