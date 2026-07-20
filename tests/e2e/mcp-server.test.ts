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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  let auditPath: string;

  beforeAll(async () => {
    if (!existsSync('dist/server.js')) {
      throw new Error('dist/server.js missing — run `npm run build` first');
    }

    await seedMongo();
    configDir = mkdtempSync(join(tmpdir(), 'data-store-mcp-e2e-'));
    const configPath = join(configDir, 'config.json');
    auditPath = join(configDir, 'audit.jsonl');
    const semanticPath = join(configDir, 'semantic.yml');
    writeFileSync(semanticPath, `models:
  - name: film
    description: Film catalog.
    provenance: introspection
    source: e2e-pagila
    table: film
    columns:
      - name: film_id
        description: Film identifier.
        provenance: introspection
        dataType: integer
      - name: title
        description: Film title.
        provenance: db_comment
        dataType: text
        profile:
          distinctCount: 1000
          nullRate: 0
          topValues:
            - value: ACADEMY DINOSAUR
              count: 1
      - name: replacement_cost
        description: Internal replacement cost.
        provenance: human
        dataType: numeric
metrics:
  - name: film_count
    description: Number of films.
    provenance: human
    verified: true
    model: film
    expression: COUNT(film_id)
`);
    writeFileSync(
      configPath,
      JSON.stringify({
        principal: '${E2E_PRINCIPAL}',
        semantic: { path: configDir },
        audit: { path: auditPath },
        memory: { path: join(configDir, 'memory') },
        limits: { maxResultBytes: 4 * 1024 * 1024, timeoutMs: 750 },
        policies: {
          roles: {
            analyst: {
              hiddenColumns: [{
                name: 'film-internal-cost',
                model: 'film',
                columns: ['replacement_cost'],
              }],
            },
          },
          principals: {
            'e2e-analyst': { roles: ['analyst'] },
          },
        },
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
        env: {
          ...inheritedEnv,
          DATA_STORE_MCP_CONFIG: configPath,
          E2E_PRINCIPAL: 'e2e-analyst',
        },
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
        'describe_model',
        'dry_plan',
        'list_metrics',
        'list_sources',
        'query',
        'search_context',
      ]);
      expect(names).not.toContain('connect_database');
      expect(names).not.toContain('inspect_database');
      expect(names).not.toContain('query_database');
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
        name: 'query',
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

    it('query uses the startup-configured source', async () => {
      const res = payload(
        await client.callTool({
          name: 'query',
          arguments: { connectionId: id, sql: 'SELECT count(*)::int AS n FROM film' },
        })
      );
      expect(res.type).toBe('postgres');
      expect(res.results[0].n).toBe(EXPECTED.film);
    });

    it('describe_model returns descriptions and profiled top values', async () => {
      const res = payload(
        await client.callTool({
          name: 'describe_model',
          arguments: { name: 'film' },
        })
      );
      expect(res.model.name).toBe('film');
      expect(res.model.description).toBe('Film catalog.');
      const title = res.model.columns.find((column: any) => column.name === 'title');
      expect(title.description).toBe('Film title.');
      expect(title.profile.topValues).toEqual([{ value: 'ACADEMY DINOSAUR', count: 1 }]);
      expect(res.model.columns.map((column: any) => column.name)).not.toContain('replacement_cost');
    });

    it('list_metrics returns documented semantic metrics', async () => {
      const res = payload(
        await client.callTool({ name: 'list_metrics', arguments: {} })
      );
      expect(res.metrics).toEqual([
        expect.objectContaining({ name: 'film_count', description: 'Number of films.' }),
      ]);
    });
  });

  describe('mysql / sakila', () => {
    const id = 'e2e-sakila';

    it('query uses the startup-configured source', async () => {
      const res = payload(
        await client.callTool({
          name: 'query',
          arguments: { connectionId: id, sql: 'SELECT count(*) AS n FROM film' },
        })
      );
      expect(res.type).toBe('mysql');
      expect(Number(res.results[0].n)).toBe(EXPECTED.film);
    });

  });

  describe('mongodb / seeded fixture', () => {
    const id = 'e2e-mongo';

    it('routes an unbounded find through the Mongo gate', async () => {
      const res = payload(
        await client.callTool({
          name: 'query',
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
        name: 'query',
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
    it('search_context labels prior art, warns on unverified models, and handles empty memory', async () => {
      expect(payload(await client.callTool({
        name: 'search_context',
        arguments: { query: 'catalog film total' },
      }))).toEqual({ precedents: [] });

      await client.callTool({
        name: 'query',
        arguments: {
          connectionId: 'e2e-pagila',
          question: 'How many catalog films are there?',
          sql: 'SELECT count(*)::int AS count FROM film',
        },
      });
      const searched = payload(await client.callTool({
        name: 'search_context',
        arguments: { query: 'How many catalog films are there?' },
      }));

      expect(searched.precedents[0]).toEqual(expect.objectContaining({
        label: expect.stringMatching(/PRIOR ART.*not ground truth/i),
        question: 'How many catalog films are there?',
        warning: expect.stringMatching(/UNVERIFIED MODEL.*film/i),
        unverifiedModels: ['film'],
      }));
    });

    // T0.11 criterion 1 — resolves with isError, does not reject.
    it('returns isError for an unknown connectionId', async () => {
      const res: any = await client.callTool({
        name: 'query',
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
        name: 'query',
        arguments: { connectionId: 'e2e-pagila' },
      });
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).error.message).toMatch(/require sql/);
    });

    it('returns structured field issues for invalid arguments', async () => {
      const res: any = await client.callTool({
        name: 'query',
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
        name: 'query',
        arguments: { connectionId: 'e2e-pagila', sql: 'SELECT * FROM no_such_table_xyz' },
      });
      expect(bad.isError).toBe(true);
      expect(JSON.parse(bad.content[0].text).error.message).toMatch(/no_such_table_xyz/);

      // Same client, same connection: the server is still alive and working.
      const good = payload(
        await client.callTool({
          name: 'query',
          arguments: { connectionId: 'e2e-pagila', sql: 'SELECT 1 AS ok' },
        })
      );
      expect(good.results[0].ok).toBe(1);
    });

    it('does not leak the error message as a generic string', async () => {
      const res: any = await client.callTool({
        name: 'query',
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
          name: 'query',
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
          name: 'query',
          arguments: { connectionId: 'e2e-pagila', sql: 'SELECT * FROM film LIMIT 3' },
        })
      );
      expect(res.results).toHaveLength(3);
      expect(res.appliedLimit).toBe(3);
    });

    it('returns an error when one row exceeds the configured byte cap', async () => {
      const res: any = await client.callTool({
        name: 'query',
        arguments: {
          connectionId: 'e2e-pagila',
          sql: `SELECT repeat('x', 5000000) AS payload`,
        },
      });

      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).error.message).toMatch(
        /Result exceeded the 4194304-byte cap \([4-9][0-9]+ bytes\)/,
      );
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
        name: 'query',
        arguments: { connectionId: 'e2e-pagila', sql },
      });
      expect(res.isError).toBe(true);
    });

    it('refuses a data-modifying CTE that parses as a SELECT', async () => {
      const res: any = await client.callTool({
        name: 'query',
        arguments: {
          connectionId: 'e2e-pagila',
          sql: 'WITH x AS (DELETE FROM film RETURNING *) SELECT * FROM x',
        },
      });
      expect(res.isError).toBe(true);
    });

    it('refuses a multi-statement payload', async () => {
      const res: any = await client.callTool({
        name: 'query',
        arguments: { connectionId: 'e2e-pagila', sql: 'SELECT 1 AS n; DROP TABLE film' },
      });
      expect(res.isError).toBe(true);
    });

    it('leaves the fixture intact after every refusal', async () => {
      const res = payload(
        await client.callTool({
          name: 'query',
          arguments: { connectionId: 'e2e-pagila', sql: 'SELECT count(*)::int AS n FROM film' },
        })
      );
      expect(res.results[0].n).toBe(EXPECTED.film);
    });

    it('appends exactly one complete audit record for every outcome', async () => {
      const before = readFileSync(auditPath, 'utf8');
      const beforeRecords = auditRecords(auditPath);

      await client.callTool({
        name: 'query',
        arguments: {
          connectionId: 'e2e-pagila',
          sql: 'SELECT 42 AS answer',
          principal: 'admin',
        },
      });
      await client.callTool({
        name: 'query',
        arguments: { connectionId: 'e2e-pagila', sql: 'DELETE FROM film' },
      });
      await client.callTool({
        name: 'query',
        arguments: {
          connectionId: 'e2e-pagila',
          sql: 'SELECT replacement_cost FROM film',
        },
      });
      await client.callTool({
        name: 'query',
        arguments: { connectionId: 'e2e-pagila' },
      });
      await client.callTool({
        name: 'query',
        arguments: { connectionId: 'e2e-pagila', sql: 'SELECT * FROM audit_missing_table' },
      });
      await client.callTool({
        name: 'query',
        arguments: { connectionId: 'e2e-pagila', sql: 'SELECT pg_sleep(5)' },
      });

      const afterText = readFileSync(auditPath, 'utf8');
      const added = auditRecords(auditPath).slice(beforeRecords.length);

      expect(afterText.startsWith(before)).toBe(true);
      expect(added).toHaveLength(6);
      expect(added.map((record) => record.outcome)).toEqual([
        'success',
        'denied',
        'denied',
        'failure',
        'failure',
        'timeout',
      ]);
      expect(added.map((record) => record.rowCount)).toEqual([1, 0, 0, 0, 0, 0]);

      for (const record of added) {
        expect(record.principal).toBe('e2e-analyst');
        expect(record.source).toBe('e2e-pagila');
        expect(typeof record.sql).toBe('string');
        expect(Array.isArray(record.appliedPolicies)).toBe(true);
        expect(record.appliedPolicies.length).toBeGreaterThan(0);
        expect(typeof record.durationMs).toBe('number');
        expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
      expect(added[0].sql).toMatch(/LIMIT 1000/i);
      expect(added[0].appliedPolicies).toContain('read-only');
      expect(added[1].appliedPolicies).toContain('read-only');
      expect(added[1].denialReason).toMatch(/DELETE is not permitted/i);
      expect(added[2]).toEqual(expect.objectContaining({
        appliedPolicies: ['analyst:film-internal-cost'],
        denialReason: 'Denied by policy: analyst:film-internal-cost',
        errorCode: 'E_POLICY_DENIED',
      }));
      expect(added[3].appliedPolicies).toEqual(['none applied']);
      expect(added[3]).not.toHaveProperty('denialReason');
      expect(added[5].errorCode).toBe('E_TIMEOUT');

      for (const password of [
        PAGILA.options.password,
        SAKILA.options.password,
        new URL(MONGO.options.uri).password,
      ]) {
        expect(afterText).not.toContain(password);
      }
    });

    it('dry_plan resolves MDL without executing or writing an audit record', async () => {
      const before = auditRecords(auditPath);
      const res = payload(await client.callTool({
        name: 'dry_plan',
        arguments: { connectionId: 'e2e-pagila', sql: 'SELECT title FROM film' },
      }));

      expect(res.resolvedTables).toEqual(['film']);
      expect(res.resolvedColumns).toEqual(['film.title']);
      expect(res.appliedLimit).toBe(1000);
      expect(res.appliedPolicies).toContain('read-only');
      expect(res.warnings).toEqual([
        expect.objectContaining({ code: 'E_UNVERIFIED_MODEL', model: 'film' }),
      ]);
      expect(auditRecords(auditPath)).toHaveLength(before.length);
    });

    it('dry_plan returns structured semantic errors', async () => {
      const res: any = await client.callTool({
        name: 'dry_plan',
        arguments: { connectionId: 'e2e-pagila', sql: 'SELECT titel FROM film' },
      });
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).error).toEqual(
        expect.objectContaining({ code: 'E_UNKNOWN_COLUMN', didYouMean: ['title'] }),
      );
    });

    it('removes hidden columns from dry plans and SELECT star results', async () => {
      const dry = payload(await client.callTool({
        name: 'dry_plan',
        arguments: { connectionId: 'e2e-pagila', sql: 'SELECT * FROM film' },
      }));
      expect(dry.sql).not.toContain('replacement_cost');
      expect(dry.resolvedColumns).not.toContain('film.replacement_cost');
      expect(dry.appliedPolicies).toContain('analyst:film-internal-cost');

      const queried = payload(await client.callTool({
        name: 'query',
        arguments: { connectionId: 'e2e-pagila', sql: 'SELECT * FROM film LIMIT 1' },
      }));
      expect(Object.keys(queried.results[0])).toEqual(['film_id', 'title']);
    });

    it('denies explicit hidden columns without leaking them in errors or suggestions', async () => {
      for (const sql of [
        'SELECT replacement_cost FROM film',
        'SELECT replacment_cost FROM film',
      ]) {
        const result: any = await client.callTool({
          name: 'dry_plan',
          arguments: { connectionId: 'e2e-pagila', sql },
        });
        expect(result.isError).toBe(true);
        const text = result.content[0].text;
        if (sql.includes('replacement_cost')) {
          expect(JSON.parse(text).error).toEqual(expect.objectContaining({
            code: 'E_POLICY_DENIED',
          }));
        }
        expect(text).not.toContain('replacement_cost');
      }
    });
  });
});

function auditRecords(path: string): any[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
