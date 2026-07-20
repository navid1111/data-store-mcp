import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDatabase } from '../../src/postgres.js';
import { MysqlDatabase } from '../../src/mysql.js';
import { buildPlan } from '../../src/governance/gate.js';
import type { Dialect } from '../../src/governance/parse.js';
import { PAGILA, SAKILA } from '../helpers/sources.js';

const MAX_BYTES = 6_000;

const engines = [
  {
    name: 'postgres',
    dialect: 'postgres' as Dialect,
    create: () => new PostgresDatabase(PAGILA),
    slowRows: `
      SELECT film_id, repeat('x', 4096) AS payload, pg_sleep(0.01)
      FROM film
      ORDER BY film_id
    `,
    health: 'SELECT 1 AS ok',
  },
  {
    name: 'mysql',
    dialect: 'mysql' as Dialect,
    create: () => new MysqlDatabase(SAKILA),
    slowRows: `
      SELECT film_id, REPEAT('x', 4096) AS payload, SLEEP(0.01) AS waited
      FROM film
      ORDER BY film_id
    `,
    health: 'SELECT 1 AS ok',
  },
] as const;

describe.each(engines)('result byte cap / $name', (engine) => {
  const db = engine.create();

  beforeAll(async () => {
    await db.connect();
  });

  afterAll(async () => {
    if (engine.name === 'postgres') {
      await (db as PostgresDatabase as any).pool?.end();
    } else {
      await (db as MysqlDatabase as any).connection?.end();
    }
  });

  it('stops streaming as soon as the serialized prefix crosses the cap', async () => {
    const plan = buildPlan(engine.slowRows, { dialect: engine.dialect });
    const started = performance.now();

    const error = await db.execute(plan, { maxBytes: MAX_BYTES }).catch((caught) => caught);
    const durationMs = performance.now() - started;

    expect(error).toMatchObject({
      code: 'E_RESULT_TOO_LARGE',
      detail: {
        code: 'E_RESULT_TOO_LARGE',
        limit: MAX_BYTES,
        actual: expect.any(Number),
      },
    });
    expect(error.detail.actual).toBeGreaterThan(MAX_BYTES);
    // Buffering all 1000 rows would spend roughly 10 seconds in SLEEP.
    expect(durationMs).toBeLessThan(1_500);
  });

  it('leaves the source usable after cancelling an oversized result', async () => {
    const rows = await db.execute(buildPlan(engine.health, { dialect: engine.dialect }), {
      maxBytes: 1_000,
    });

    expect(Number(rows[0].ok)).toBe(1);
  });

  it('returns a result that fits below the cap', async () => {
    const plan = buildPlan('SELECT film_id FROM film ORDER BY film_id LIMIT 3', {
      dialect: engine.dialect,
    });
    const rows = await db.execute(plan, { maxBytes: 1_000 });

    expect(rows).toHaveLength(3);
    expect(Buffer.byteLength(JSON.stringify(rows), 'utf8')).toBeLessThanOrEqual(1_000);
  });
});
