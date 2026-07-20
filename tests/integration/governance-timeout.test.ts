/**
 * T1.6 — query timeouts with real cancellation.
 *
 * The FAIL criterion is asserting promise timing alone: a client-side race
 * that abandons the promise leaves the query running on the server, burning
 * resources invisibly. So every case here also inspects the engine's own view
 * of running queries from a *second* connection, and confirms the original
 * connection still works afterwards.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { PostgresDatabase } from '../../src/postgres.js';
import { MysqlDatabase } from '../../src/mysql.js';
import { buildPlan } from '../../src/governance/gate.js';
import { DEFAULT_TIMEOUT_MS, resolveTimeoutMs } from '../../src/governance/plan.js';
import { PAGILA, SAKILA } from '../helpers/sources.js';

const TIMEOUT_MS = 800;

describe('resolveTimeoutMs', () => {
  it('defaults to the documented value', () => {
    expect(resolveTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  it('accepts a positive integer', () => {
    expect(resolveTimeoutMs({ timeoutMs: 500 })).toBe(500);
  });

  // The value is interpolated into a SET statement, which takes no bind
  // parameters — so validation is what keeps that safe.
  it.each([0, -1, 1.5, NaN, Infinity])('rejects %s', (value) => {
    expect(() => resolveTimeoutMs({ timeoutMs: value })).toThrow(RangeError);
  });

  it('rejects a string that would inject SQL', () => {
    expect(() =>
      resolveTimeoutMs({ timeoutMs: '0; DROP TABLE film' as unknown as number })
    ).toThrow(RangeError);
  });
});

describe('postgres timeout', () => {
  let db: PostgresDatabase;
  let observer: pg.Client;

  beforeAll(async () => {
    db = new PostgresDatabase(PAGILA);
    await db.connect();
    observer = new pg.Client(PAGILA.options);
    await observer.connect();
  }, 60_000);

  afterAll(async () => {
    await observer.end().catch(() => undefined);
    await (db as any).pool?.end();
  });

  const runningSleeps = async () => {
    const { rows } = await observer.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE query LIKE '%pg_sleep%' AND query NOT LIKE '%pg_stat_activity%'
         AND state = 'active'`
    );
    return rows[0].n as number;
  };

  it('cancels a slow query and reports E_TIMEOUT', async () => {
    const plan = buildPlan('SELECT pg_sleep(10)', { dialect: 'postgres' });
    const started = Date.now();

    await expect(db.execute(plan, { timeoutMs: TIMEOUT_MS })).rejects.toMatchObject({
      detail: { code: 'E_TIMEOUT', timeoutMs: TIMEOUT_MS },
    });

    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS + 1_500);
  });

  // The assertion that separates real cancellation from an abandoned promise.
  it('leaves no query running on the server', async () => {
    const plan = buildPlan('SELECT pg_sleep(10)', { dialect: 'postgres' });
    await db.execute(plan, { timeoutMs: TIMEOUT_MS }).catch(() => undefined);

    // Poll briefly: cancellation is asynchronous on the server side.
    let running = await runningSleeps();
    for (let i = 0; i < 20 && running > 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      running = await runningSleeps();
    }
    expect(running).toBe(0);
  });

  it('leaves the connection usable', async () => {
    const rows = await db.execute(buildPlan('SELECT 1 AS ok', { dialect: 'postgres' }));
    expect(rows[0].ok).toBe(1);
  });

  it('does not leak statement_timeout to later queries', async () => {
    // A 3s sleep would fail if the 800ms timeout were still in force on the
    // pooled connection.
    const plan = buildPlan('SELECT pg_sleep(1.5)', { dialect: 'postgres' });
    await expect(db.execute(plan, { timeoutMs: 10_000 })).resolves.toBeDefined();
  });

  it('completes a fast query well inside the timeout', async () => {
    const plan = buildPlan('SELECT count(*)::int AS n FROM film', { dialect: 'postgres' });
    const rows = await db.execute(plan, { timeoutMs: TIMEOUT_MS });
    expect(rows[0].n).toBe(1000);
  });
});

describe('mysql timeout', () => {
  let db: MysqlDatabase;
  let observer: mysql.Connection;

  // SLEEP() is exempt from max_execution_time by design, so a genuinely
  // expensive join is used instead — which is also closer to the real failure
  // mode this protects against.
  const SLOW = `
    SELECT count(*) AS n
    FROM film f1 JOIN film f2 JOIN film f3
    WHERE f1.title <> f2.title AND f2.title <> f3.title
  `;

  beforeAll(async () => {
    db = new MysqlDatabase(SAKILA);
    await db.connect();
    observer = await mysql.createConnection(SAKILA.options);
  }, 60_000);

  afterAll(async () => {
    await observer.end().catch(() => undefined);
    await (db as any).connection?.end();
  });

  it('cancels a slow query and reports E_TIMEOUT', async () => {
    const plan = buildPlan(SLOW, { dialect: 'mysql' });
    const started = Date.now();

    await expect(db.execute(plan, { timeoutMs: TIMEOUT_MS })).rejects.toMatchObject({
      detail: { code: 'E_TIMEOUT', timeoutMs: TIMEOUT_MS },
    });

    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS + 1_500);
  });

  it('leaves no query running on the server', async () => {
    const plan = buildPlan(SLOW, { dialect: 'mysql' });
    await db.execute(plan, { timeoutMs: TIMEOUT_MS }).catch(() => undefined);

    // Excludes the observer's own row: this very statement contains the
    // search pattern in its INFO, so without the filter it always matches
    // itself and the test can never pass.
    let running = 1;
    for (let i = 0; i < 20 && running > 0; i++) {
      const [rows] = await observer.query(
        `SELECT count(*) AS n FROM information_schema.PROCESSLIST
         WHERE INFO LIKE '%f1.title%' AND COMMAND <> 'Sleep'
           AND ID <> CONNECTION_ID()`
      );
      running = Number((rows as any[])[0].n);
      if (running > 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(running).toBe(0);
  });

  it('leaves the connection usable', async () => {
    const rows = await db.execute(buildPlan('SELECT 1 AS ok', { dialect: 'mysql' }));
    expect(rows[0].ok).toBe(1);
  });

  it('does not leak max_execution_time to later queries', async () => {
    const [rows] = await (db as any).connection.query(
      'SELECT @@SESSION.max_execution_time AS t'
    );
    expect(Number(rows[0].t)).toBe(0);
  });

  it('completes a fast query well inside the timeout', async () => {
    const plan = buildPlan('SELECT count(*) AS n FROM film', { dialect: 'mysql' });
    const rows = await db.execute(plan, { timeoutMs: TIMEOUT_MS });
    expect(Number(rows[0].n)).toBe(1000);
  });
});
