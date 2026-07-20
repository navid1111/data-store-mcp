import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Database } from '../../src/database-source.js';
import { runGoldenEval } from '../../src/evaluation/golden.js';
import type { Dialect } from '../../src/governance/parse.js';
import { MysqlDatabase } from '../../src/mysql.js';
import { parseQueriesYaml } from '../../src/orchestrator/context.js';
import { PostgresDatabase } from '../../src/postgres.js';
import { PAGILA, SAKILA } from '../helpers/sources.js';

interface Engine {
  label: string;
  dialect: Dialect;
  database: Database;
  close: () => Promise<void>;
}

const engines: Engine[] = [];
const fixture = new URL('../golden-queries.yml', import.meta.url);

beforeAll(async () => {
  const postgres = new PostgresDatabase(PAGILA);
  const mysql = new MysqlDatabase(SAKILA);
  await Promise.all([postgres.connect(), mysql.connect()]);
  engines.push(
    {
      label: 'postgres',
      dialect: 'postgres',
      database: postgres,
      close: async () => { await (postgres as any).pool?.end(); },
    },
    {
      label: 'mysql',
      dialect: 'mysql',
      database: mysql,
      close: async () => { await (mysql as any).connection?.end(); },
    },
  );
}, 60_000);

afterAll(async () => {
  await Promise.all(engines.map((engine) => engine.close()));
});

describe('golden query evaluation', () => {
  it.each(['postgres', 'mysql'])('runs every fixture case and reports failures / %s', async (label) => {
    const engine = engines.find((candidate) => candidate.label === label)!;
    const queries = parseQueriesYaml(await readFile(fixture, 'utf8'), fixture.pathname);
    const report = await runGoldenEval(engine.database, queries, {
      dialect: engine.dialect,
      threshold: 0.5,
    });

    expect(report).toEqual(expect.objectContaining({
      total: 3,
      passed: 2,
      failed: 1,
      passRate: 2 / 3,
      exitCode: 0,
    }));
    expect(report.cases.find((item) => item.question === 'Unordered film identifiers'))
      .toEqual(expect.objectContaining({ status: 'passed', ordered: false }));
    expect(report.cases.find((item) => item.question === 'Ordered film identifiers'))
      .toEqual(expect.objectContaining({ status: 'passed', ordered: true }));
    expect(report.output).toMatch(/FAIL Deliberately broken golden query/);
  }, 60_000);

  it('returns non-zero below the configured threshold', async () => {
    const queries = parseQueriesYaml(await readFile(fixture, 'utf8'), fixture.pathname);
    const report = await runGoldenEval(engines[0].database, queries, {
      dialect: engines[0].dialect,
      threshold: 0.8,
    });
    expect(report.exitCode).toBe(1);
  });

  it('treats the same rows in the wrong order as a failure when ORDER BY is present', async () => {
    const report = await runGoldenEval(engines[0].database, [{
      question: 'Wrong ordered expectation',
      sql: 'SELECT film_id FROM film WHERE film_id IN (1, 2, 3) ORDER BY film_id',
      expected: [{ film_id: 3 }, { film_id: 2 }, { film_id: 1 }],
    }], { dialect: engines[0].dialect });

    expect(report.cases[0]).toEqual(expect.objectContaining({ status: 'failed', ordered: true }));
  });
});
