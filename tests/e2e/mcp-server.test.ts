/**
 * End-to-end test of the actual MCP server: spawns `node dist/server.js`,
 * speaks real MCP over stdio, and drives the published tools against the
 * Pagila and Sakila fixtures.
 *
 * This is the only suite that exercises startup config, the source registry,
 * tool schemas, and the response envelope. Adapter suites bypass all of it.
 *
 * Requires `npm run build` first — see the global setup guard below.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PAGILA, SAKILA, MONGO, EXPECTED } from '../helpers/sources.js';
import { seedMongo } from '../helpers/seed-mongo.js';

/** Tool results come back as a text envelope containing JSON. */
function payload(result: any): any {
  expect(result.content?.[0]?.type).toBe('text');
  return JSON.parse(result.content[0].text);
}

describe('MCP server (stdio) / Pagila + Sakila', () => {
  let client: Client;
  let configDir: string;

  beforeAll(async () => {
    if (!existsSync('dist/server.js')) {
      throw new Error('dist/server.js missing — run `npm run build` first');
    }

    await seedMongo();
    configDir = mkdtempSync(join(tmpdir(), 'data-store-mcp-e2e-'));
    const configPath = join(configDir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        sources: [
          {
            name: 'e2e-pagila',
            type: 'postgres',
            description: 'Pagila fixture',
            options: PAGILA.options,
          },
          {
            name: 'e2e-sakila',
            type: 'mysql',
            description: 'Sakila fixture',
            options: SAKILA.options,
          },
          {
            name: 'e2e-mongo',
            type: 'mongodb',
            description: 'Mongo fixture',
            options: MONGO.options,
          },
        ],
      }),
    );

    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] =>
        typeof entry[1] === 'string'
      ),
    );

    client = new Client({ name: 'e2e-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(
      new StdioClientTransport({
        command: 'node',
        args: ['dist/server.js'],
        env: { ...inheritedEnv, DATA_STORE_MCP_CONFIG: configPath },
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    if (configDir) rmSync(configDir, { recursive: true, force: true });
  });

  describe('tools/list', () => {
    it('publishes the registered tools', async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'echo',
        'inspect_database',
        'list_sources',
        'query_database',
      ]);
      expect(names).not.toContain('connect_database');
      expect(JSON.stringify(tools.map((tool) => tool.inputSchema))).not.toMatch(/password/i);
    });

    it('list_sources returns safe descriptors for startup-configured sources', async () => {
      const res = payload(
        await client.callTool({ name: 'list_sources', arguments: {} }),
      );

      expect(res.sources).toEqual([
        { name: 'e2e-mongo', type: 'mongodb', description: 'Mongo fixture' },
        { name: 'e2e-pagila', type: 'postgres', description: 'Pagila fixture' },
        { name: 'e2e-sakila', type: 'mysql', description: 'Sakila fixture' },
      ]);
      expect(JSON.stringify(res)).not.toMatch(/options|password|uri|host|user/i);
    });

    it('keeps fixture passwords out of a complete list-and-call transcript', async () => {
      const listed = await client.listTools();
      const sources = await client.callTool({ name: 'list_sources', arguments: {} });
      const queried = await client.callTool({
        name: 'query_database',
        arguments: { connectionId: 'e2e-pagila', sql: 'SELECT 1 AS ok' },
      });
      const transcript = JSON.stringify({ listed, sources, queried });

      for (const password of new Set([
        PAGILA.options.password,
        SAKILA.options.password,
        new URL(MONGO.options.uri).password,
      ])) {
        expect(password).not.toBe('');
        expect(transcript).not.toContain(password);
      }
    });
  });

  describe('postgres / pagila', () => {
    const id = 'e2e-pagila';

    it('query_database uses the startup-configured source', async () => {
      const res = payload(
        await client.callTool({
          name: 'query_database',
          arguments: { connectionId: id, sql: 'SELECT count(*)::int AS n FROM film' },
        })
      );
      expect(res.type).toBe('postgres');
      expect(res.results[0].n).toBe(EXPECTED.film);
    });

    it('inspect_database nests columns under a named table', async () => {
      const res = payload(
        await client.callTool({
          name: 'inspect_database',
          arguments: { connectionId: id, name: 'film' },
        })
      );
      expect(res.tables).toHaveLength(1);
      expect(res.tables[0].name).toBe('film');
      expect(res.tables[0].columns.map((c: any) => c.name)).toContain('title');
      expect(res.relations.length).toBeGreaterThan(10);
    });

    // T0.5 — previously returned a flat, unattributable column list (B7).
    it('inspect_database attributes every column when no table is named', async () => {
      const res = payload(
        await client.callTool({ name: 'inspect_database', arguments: { connectionId: id } })
      );
      expect(res.tables.length).toBeGreaterThan(5);
      for (const table of res.tables) {
        expect(typeof table.name).toBe('string');
        expect(Array.isArray(table.columns)).toBe(true);
        expect(table.columns.every((c: any) => c.table === table.name)).toBe(true);
      }
    });
  });

  describe('mysql / sakila', () => {
    const id = 'e2e-sakila';

    it('query_database uses the startup-configured source', async () => {
      const res = payload(
        await client.callTool({
          name: 'query_database',
          arguments: { connectionId: id, sql: 'SELECT count(*) AS n FROM film' },
        })
      );
      expect(res.type).toBe('mysql');
      expect(Number(res.results[0].n)).toBe(EXPECTED.film);
    });

    it('inspect_database returns the same shape as Postgres', async () => {
      const res = payload(
        await client.callTool({
          name: 'inspect_database',
          arguments: { connectionId: id, name: 'film' },
        })
      );
      expect(res.tables).toHaveLength(1);
      expect(res.tables[0].columns.map((c: any) => c.name)).toContain('title');
      expect(res.tables[0].columns[0]).not.toHaveProperty('Field');
      expect(res.relations.length).toBeGreaterThan(10);
    });
  });

  describe('mongodb / seeded fixture', () => {
    const id = 'e2e-mongo';

    it('routes an unbounded find through the Mongo gate', async () => {
      const res = payload(
        await client.callTool({
          name: 'query_database',
          arguments: {
            connectionId: id,
            query: { operation: 'find', collection: 'film' },
          },
        }),
      );

      expect(res.appliedLimit).toBe(1000);
      expect(res.appliedPolicies).toContain('mongo-read-only');
      expect(res.query.limit).toBe(1000);
    });

    it('refuses a writing aggregate stage through the real tool', async () => {
      const res: any = await client.callTool({
        name: 'query_database',
        arguments: {
          connectionId: id,
          query: {
            operation: 'aggregate',
            collection: 'film',
            pipeline: [{ $out: 'dsm_test_forbidden_output' }],
          },
        },
      });

      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).error.message).toMatch(/\$out.*not permitted/i);
    });
  });

  describe('error handling', () => {
    // T0.11 criterion 1 — resolves with isError, does not reject.
    it('returns isError for an unknown connectionId', async () => {
      const res: any = await client.callTool({
        name: 'query_database',
        arguments: { connectionId: 'nope', sql: 'SELECT 1' },
      });
      expect(res.isError).toBe(true);
      const { error } = JSON.parse(res.content[0].text);
      expect(error.code).toBe('EXECUTION_FAILED');
      expect(error.message).toMatch(/Source not found: nope/);
    });

    // T0.11 criterion 2.
    it('returns isError for a SQL source called with no sql', async () => {
      const res: any = await client.callTool({
        name: 'query_database',
        arguments: { connectionId: 'e2e-pagila' },
      });
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).error.message).toMatch(/require sql/);
    });

    it('returns structured field issues for invalid arguments', async () => {
      const res: any = await client.callTool({
        name: 'query_database',
        arguments: { connectionId: 42 },
      });
      expect(res.isError).toBe(true);
      const { error } = JSON.parse(res.content[0].text);
      expect(error.code).toBe('INVALID_ARGUMENTS');
      expect(error.issues[0].path).toBe('connectionId');
    });

    // T0.11 criterion 3 — a driver failure must not kill the server.
    it('survives a driver-level failure and stays usable', async () => {
      const bad: any = await client.callTool({
        name: 'query_database',
        arguments: { connectionId: 'e2e-pagila', sql: 'SELECT * FROM no_such_table_xyz' },
      });
      expect(bad.isError).toBe(true);
      expect(JSON.parse(bad.content[0].text).error.message).toMatch(/no_such_table_xyz/);

      // Same client, same connection: the server is still alive and working.
      const good = payload(
        await client.callTool({
          name: 'query_database',
          arguments: { connectionId: 'e2e-pagila', sql: 'SELECT 1 AS ok' },
        })
      );
      expect(good.results[0].ok).toBe(1);
    });

    it('does not leak the error message as a generic string', async () => {
      const res: any = await client.callTool({
        name: 'query_database',
        arguments: { connectionId: 'nope', sql: 'SELECT 1' },
      });
      // "Tool execution failed" alone gives the agent nothing to act on.
      expect(res.content[0].text).not.toMatch(/^Tool execution failed$/);
    });

    // T0.11 criterion 4 — unknown *tool* is legitimately a protocol error and
    // must not be converted alongside the others.
    it('still rejects an unknown tool at protocol level', async () => {
      await expect(
        client.callTool({ name: 'no_such_tool', arguments: {} })
      ).rejects.toThrow(/Unknown tool/);
    });

    // T1.5 — GAP B2 closed: agent SQL now goes through the governance gate.
    it('caps an unbounded SELECT at the configured limit', async () => {
      const res = payload(
        await client.callTool({
          name: 'query_database',
          arguments: { connectionId: 'e2e-pagila', sql: 'SELECT * FROM film' },
        })
      );
      expect(res.results.length).toBe(1000);
      expect(res.appliedLimit).toBe(1000);
      expect(res.appliedPolicies).toContain('read-only');
    });

    it('preserves a caller limit smaller than the default', async () => {
      const res = payload(
        await client.callTool({
          name: 'query_database',
          arguments: { connectionId: 'e2e-pagila', sql: 'SELECT * FROM film LIMIT 3' },
        })
      );
      expect(res.results).toHaveLength(3);
      expect(res.appliedLimit).toBe(3);
    });

    // T1.3 through the real MCP surface, with the fixture checked afterwards:
    // a refusal that still executed would show up as a changed row count.
    it.each([
      ['DROP TABLE film'],
      ['DELETE FROM film'],
      ['UPDATE film SET title = $$x$$'],
      ['INSERT INTO film (title) VALUES ($$x$$)'],
      ['TRUNCATE TABLE film'],
    ])('refuses %s', async (sql) => {
      const res: any = await client.callTool({
        name: 'query_database',
        arguments: { connectionId: 'e2e-pagila', sql },
      });
      expect(res.isError).toBe(true);
    });

    it('refuses a data-modifying CTE that parses as a SELECT', async () => {
      const res: any = await client.callTool({
        name: 'query_database',
        arguments: {
          connectionId: 'e2e-pagila',
          sql: 'WITH x AS (DELETE FROM film RETURNING *) SELECT * FROM x',
        },
      });
      expect(res.isError).toBe(true);
    });

    it('refuses a multi-statement payload', async () => {
      const res: any = await client.callTool({
        name: 'query_database',
        arguments: { connectionId: 'e2e-pagila', sql: 'SELECT 1 AS n; DROP TABLE film' },
      });
      expect(res.isError).toBe(true);
    });

    it('leaves the fixture intact after every refusal', async () => {
      const res = payload(
        await client.callTool({
          name: 'query_database',
          arguments: { connectionId: 'e2e-pagila', sql: 'SELECT count(*)::int AS n FROM film' },
        })
      );
      expect(res.results[0].n).toBe(EXPECTED.film);
    });
  });
});
