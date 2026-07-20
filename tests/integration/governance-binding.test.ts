/**
 * T1.7 — parameter binding, against live engines.
 *
 * The property under test is that a caller-supplied *value* can never change
 * the shape of the statement. Asserted end-to-end rather than on generated
 * SQL: a value that reached the parser as syntax would change the result set
 * or mutate the fixture, and both are checked.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from '../../src/database-source.js';
import { PostgresDatabase } from '../../src/postgres.js';
import { MysqlDatabase } from '../../src/mysql.js';
import { buildPlan } from '../../src/governance/gate.js';
import type { Dialect } from '../../src/governance/parse.js';
import { PAGILA, SAKILA, EXPECTED } from '../helpers/sources.js';

interface Engine {
  label: string;
  dialect: Dialect;
  make: () => Database;
  /** Placeholder syntax for the engine. */
  ph: (n: number) => string;
  close: (db: Database) => Promise<void>;
}

const engines: Engine[] = [
  {
    label: 'postgres',
    dialect: 'postgres',
    make: () => new PostgresDatabase(PAGILA),
    ph: (n) => `$${n}`,
    close: async (db) => { await (db as any).pool?.end(); },
  },
  {
    label: 'mysql',
    dialect: 'mysql',
    make: () => new MysqlDatabase(SAKILA),
    ph: () => '?',
    close: async (db) => { await (db as any).connection?.end(); },
  },
];

describe.each(engines)('parameter binding / $label', (engine) => {
  let db: Database;

  const run = (sql: string, params?: unknown[]) =>
    db.execute(buildPlan(sql, { dialect: engine.dialect, params })) as Promise<any[]>;

  beforeAll(async () => {
    db = engine.make();
    await db.connect();
  }, 60_000);

  afterAll(async () => {
    await engine.close(db);
  });

  describe('binds values', () => {
    it('filters by a bound parameter', async () => {
      const rows = await run(
        `SELECT title, rating FROM film WHERE rating = ${engine.ph(1)}`,
        ['PG-13']
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.rating === 'PG-13')).toBe(true);
    });

    it('preserves the placeholder through the gate rewrite', async () => {
      const plan = buildPlan(
        `SELECT title FROM film WHERE rating = ${engine.ph(1)}`,
        { dialect: engine.dialect, params: ['G'] }
      );
      expect(plan.sql).toContain(engine.ph(1));
      expect(plan.params).toEqual(['G']);
    });

    it('binds multiple parameters positionally', async () => {
      const rows = await run(
        `SELECT title FROM film WHERE rating = ${engine.ph(1)} AND length > ${engine.ph(2)}`,
        ['R', 150]
      );
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  describe('values cannot become syntax', () => {
    // Filters on `title` rather than `rating`: Pagila types rating as an enum,
    // so a non-member value raises a cast error. That error is itself evidence
    // the input was treated as a value, but zero rows is the clearer assertion.
    it('treats an injection payload as a literal, returning nothing', async () => {
      const rows = await run(
        `SELECT title FROM film WHERE title = ${engine.ph(1)}`,
        ["'; DROP TABLE film; --"]
      );
      expect(rows).toEqual([]);
    });

    it('leaves the fixture intact afterwards', async () => {
      const rows = await run('SELECT count(*) AS n FROM film');
      expect(Number(rows[0].n)).toBe(EXPECTED.film);
    });

    it('round-trips a value containing a single quote', async () => {
      const rows = await run(`SELECT ${engine.ph(1)} AS v`, ["O'Brien"]);
      expect(rows[0].v).toBe("O'Brien");
    });

    it('round-trips a value containing a backslash and quotes', async () => {
      const value = `a\\'b"c`;
      const rows = await run(`SELECT ${engine.ph(1)} AS v`, [value]);
      expect(rows[0].v).toBe(value);
    });

    it('treats a UNION payload as a literal', async () => {
      const rows = await run(
        `SELECT title FROM film WHERE title = ${engine.ph(1)}`,
        ["ACADEMY DINOSAUR' UNION SELECT password FROM users --"]
      );
      expect(rows).toEqual([]);
    });

    // Worth keeping because `rating` is an enum in both fixtures, so the
    // payload has to be coerced to a typed value. The engines disagree on how
    // strictly: Postgres raises a cast error, MySQL silently matches nothing.
    // Either outcome proves it arrived as a value; what must never happen is
    // rows coming back.
    it('never returns rows for an injection payload on a typed column', async () => {
      const result = await run(
        `SELECT title FROM film WHERE rating = ${engine.ph(1)}`,
        ["'; DROP TABLE film; --"]
      ).catch((error) => error as Error);

      if (Array.isArray(result)) {
        expect(result).toEqual([]);
      } else {
        expect(result).toBeInstanceOf(Error);
      }
    });
  });

  describe('literals inside agent SQL', () => {
    // The agent authors the whole statement, so literals arrive as part of it
    // rather than as parameters. They are re-emitted by the AST round-trip,
    // which escapes them correctly — asserted here rather than assumed.
    it('re-escapes an embedded quote correctly', async () => {
      const rows = await run(`SELECT 'O''Brien' AS v`);
      expect(rows[0].v).toBe("O'Brien");
    });

    it('does not let an embedded literal terminate the statement', async () => {
      // If the round-trip mis-escaped this, the trailing text would parse as
      // SQL and the statement would fail or do something else entirely.
      const rows = await run(`SELECT '; DROP TABLE film; --' AS v`);
      expect(rows[0].v).toBe('; DROP TABLE film; --');
    });

    it('still has the fixture after embedded-literal tests', async () => {
      const rows = await run('SELECT count(*) AS n FROM film');
      expect(Number(rows[0].n)).toBe(EXPECTED.film);
    });
  });
});
