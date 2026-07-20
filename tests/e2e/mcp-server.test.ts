/**
 * End-to-end test of the actual MCP server: spawns `node dist/server.js`,
 * speaks real MCP over stdio, and drives the published tools against the
 * Pagila and Sakila fixtures.
 *
 * This is the only suite that exercises the tool layer (registry, zod schemas,
 * ConnectionManager, response envelope). The adapter suites bypass all of it.
 *
 * Requires `npm run build` first — see the global setup guard below.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PAGILA, SAKILA, EXPECTED } from '../helpers/sources.js';

/** Tool results come back as a text envelope containing JSON. */
function payload(result: any): any {
  expect(result.content?.[0]?.type).toBe('text');
  return JSON.parse(result.content[0].text);
}

describe('MCP server (stdio) / Pagila + Sakila', () => {
  let client: Client;

  beforeAll(async () => {
    if (!existsSync('dist/server.js')) {
      throw new Error('dist/server.js missing — run `npm run build` first');
    }

    client = new Client({ name: 'e2e-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(
      new StdioClientTransport({ command: 'node', args: ['dist/server.js'] })
    );
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  describe('tools/list', () => {
    it('publishes the registered tools', async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'connect_database',
        'echo',
        'inspect_database',
        'query_database',
      ]);
    });

    // GAP (spec B1): SQL Server is implemented but the tool enum omits it, so
    // it is unreachable through MCP. Deferred, but assert it stays deliberate.
    it('GAP B1: connect_database does not offer sqlserver', async () => {
      const { tools } = await client.listTools();
      const connect = tools.find((t) => t.name === 'connect_database')!;
      const types = (connect.inputSchema as any).properties.type.enum;
      expect(types).toEqual(['mysql', 'postgres', 'mongodb']);
    });
  });

  describe('postgres / pagila', () => {
    const id = 'e2e-pagila';

    it('connect_database connects to Pagila', async () => {
      const res = payload(
        await client.callTool({
          name: 'connect_database',
          arguments: { type: 'postgres', id, ...PAGILA.options },
        })
      );
      expect(res.connectionId).toBe(id);
      expect(res.message).toMatch(/Successfully connected/);
    });

    it('query_database runs a real query', async () => {
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

    it('connect_database connects to Sakila', async () => {
      const res = payload(
        await client.callTool({
          name: 'connect_database',
          arguments: { type: 'mysql', id, ...SAKILA.options },
        })
      );
      expect(res.connectionId).toBe(id);
    });

    it('query_database runs a real query', async () => {
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
      expect(error.message).toMatch(/Connection not found: nope/);
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

    // T0.11 criterion 5. Uses a malformed Mongo URI specifically because
    // MongoParseError echoes the connection string verbatim ("Protocol and
    // host list are required in \"mongodb://user:pw@\""), so this genuinely
    // exercises redaction. A connection-refused error would not: neither pg
    // nor mongodb includes credentials on that path, and asserting against it
    // would pass whether or not redaction existed.
    it('redacts the password from a driver error that echoes the URI', async () => {
      const res: any = await client.callTool({
        name: 'connect_database',
        arguments: {
          type: 'mongodb',
          uri: 'mongodb://dsm:super_secret_pw@',
          database: 'nope',
          id: 'e2e-badmongo',
        },
      });
      expect(res.isError).toBe(true);
      const text = res.content[0].text;
      // Proves the leaky message reached us and was scrubbed, not that no
      // message arrived.
      expect(text).toMatch(/Protocol and host list are required/);
      expect(text).toContain('mongodb://dsm:***@');
      expect(text).not.toContain('super_secret_pw');
    });

    it('leaks no password anywhere in a failed SQL connect', async () => {
      const res: any = await client.callTool({
        name: 'connect_database',
        arguments: {
          type: 'postgres',
          host: '127.0.0.1',
          port: 1,
          user: 'nobody',
          password: 'super_secret_pw',
          database: 'nope',
          id: 'e2e-badconn',
        },
      });
      expect(res.isError).toBe(true);
      // Regression guard rather than proof: pg reports ECONNREFUSED without
      // the password today, so this asserts that stays true.
      expect(JSON.stringify(res)).not.toContain('super_secret_pw');
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
