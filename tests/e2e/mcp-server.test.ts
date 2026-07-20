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

    it('inspect_database returns tables and relations for a named table', async () => {
      const res = payload(
        await client.callTool({
          name: 'inspect_database',
          arguments: { connectionId: id, name: 'film' },
        })
      );
      expect(res.tables.map((c: any) => c.column_name)).toContain('title');
      expect(res.relations.length).toBeGreaterThan(10);
    });

    // GAP (spec B7): with no table name, inspect_database returns every column
    // in the schema with no table attribution — the agent cannot tell which
    // table any column belongs to. This is B7 surfacing at the MCP layer.
    it('GAP B7: inspect_database without a table returns unattributed columns', async () => {
      const res = payload(
        await client.callTool({ name: 'inspect_database', arguments: { connectionId: id } })
      );
      expect(res.tables.length).toBeGreaterThan(50);
      expect(res.tables[0]).not.toHaveProperty('table_name');
    });

    it.todo('after 0.5: inspect_database returns tables with their columns nested');
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

    it('inspect_database works (exercises the B12 optional-arg fallback)', async () => {
      const res = payload(
        await client.callTool({
          name: 'inspect_database',
          arguments: { connectionId: id, name: 'film' },
        })
      );
      expect(res.tables.map((c: any) => c.Field)).toContain('title');
      expect(res.relations.length).toBeGreaterThan(10);
    });
  });

  describe('error handling', () => {
    // GAP (spec B14): the handler throws, so tool *execution* failures surface
    // as JSON-RPC protocol errors (-32603) rather than as a tool result with
    // isError: true. A protocol error is not part of the model's tool-result
    // stream, so the agent cannot read the message and self-correct — which is
    // exactly what R2.2 (structured errors with hints) depends on.
    it('GAP B14: unknown connectionId raises a protocol error, not a tool result', async () => {
      await expect(
        client.callTool({
          name: 'query_database',
          arguments: { connectionId: 'nope', sql: 'SELECT 1' },
        })
      ).rejects.toThrow(/-32603.*Connection not found/);
    });

    it('GAP B14: a missing sql argument raises a protocol error', async () => {
      await expect(
        client.callTool({ name: 'query_database', arguments: { connectionId: 'e2e-pagila' } })
      ).rejects.toThrow(/-32603.*require sql/);
    });

    it.todo('after R2.2: execution failures return isError + structured payload');

    // Unknown *tool* is legitimately a protocol error, unlike the two above.
    it('rejects an unknown tool', async () => {
      await expect(
        client.callTool({ name: 'no_such_tool', arguments: {} })
      ).rejects.toThrow(/Unknown tool/);
    });

    // GAP (spec B2): the tool layer applies no row limit and no read-only
    // guard. This is the Phase 1 hole, demonstrated through the real MCP
    // surface rather than argued from the source.
    it('GAP B2: executes an unbounded SELECT with no row cap', async () => {
      const res = payload(
        await client.callTool({
          name: 'query_database',
          arguments: { connectionId: 'e2e-pagila', sql: 'SELECT * FROM film' },
        })
      );
      expect(res.results.length).toBe(EXPECTED.film); // all 1000 rows reach the agent
    });

    it.todo('after 1.5: caps result rows at the configured limit');
    it.todo('after 1.3: refuses INSERT/UPDATE/DELETE/DROP with E_WRITE_FORBIDDEN');
  });
});
