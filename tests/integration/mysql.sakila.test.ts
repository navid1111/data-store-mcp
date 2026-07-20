/**
 * MysqlDatabase against the Sakila sample database.
 *
 * As in the Pagila suite, tests marked GAP assert current behaviour that
 * spec.md flags as a defect, paired with an `it.todo` for the target state.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MysqlDatabase } from '../../src/mysql.js';
import { InvalidIdentifierError } from '../../src/identifiers.js';
import { Database } from '../../src/database-source.js';
import { SAKILA, EXPECTED } from '../helpers/sources.js';

describe('MysqlDatabase / Sakila', () => {
  let db: MysqlDatabase;

  beforeAll(async () => {
    db = new MysqlDatabase(SAKILA);
    await db.connect();
  });

  afterAll(async () => {
    await (db as any).connection?.end();
  });

  describe('connect', () => {
    it('connects and runs a trivial query', async () => {
      const rows = await db.query('SELECT 1 AS ok');
      expect(rows[0].ok).toBe(1);
    });
  });

  describe('query', () => {
    it('reads the expected fixture row counts', async () => {
      const rows = await db.query('SELECT count(*) AS count FROM film');
      expect(Number(rows[0].count)).toBe(EXPECTED.film);
    });

    it('supports parameterized queries', async () => {
      const rows = await db.query(
        'SELECT title, rating FROM film WHERE rating = ? ORDER BY title LIMIT 3',
        ['PG-13']
      );
      expect(rows).toHaveLength(3);
      expect(rows.every((r: any) => r.rating === 'PG-13')).toBe(true);
    });

    it('joins across a declared relationship', async () => {
      const rows = await db.query(`
        SELECT a.first_name, a.last_name, count(fa.film_id) AS films
        FROM actor a
        JOIN film_actor fa ON fa.actor_id = a.actor_id
        GROUP BY a.actor_id, a.first_name, a.last_name
        ORDER BY films DESC
        LIMIT 5
      `);
      expect(rows).toHaveLength(5);
      expect(Number(rows[0].films)).toBeGreaterThan(0);
    });

    it('reads a Sakila view', async () => {
      const rows = await db.query('SELECT * FROM customer_list LIMIT 5');
      expect(rows).toHaveLength(5);
    });
  });

  describe('getSchema', () => {
    // GAP (spec B9): MySQL returns DESCRIBE output — Field/Type/Null — while
    // Postgres returns column_name/data_type/is_nullable for the same call.
    // A bootstrap pipeline cannot consume both without per-adapter branching.
    it('GAP B9: returns DESCRIBE-shaped rows for a named table', async () => {
      const cols = await db.getSchema('film');
      const names = cols.map((c: any) => c.Field);

      expect(names).toContain('film_id');
      expect(names).toContain('title');
      expect(Object.keys(cols[0])).toContain('Field');
      expect(Object.keys(cols[0])).not.toContain('column_name');
    });

    // GAP (spec B9): with no argument this returns *table names*, not columns —
    // a different return type from the same method.
    it('GAP B9: returns table names when called without a table', async () => {
      const rows = await db.getSchema();
      const key = Object.keys(rows[0])[0];
      const tables = rows.map((r: any) => r[key]);

      expect(tables).toContain('film');
      expect(tables).toContain('actor');
      expect(rows[0]).not.toHaveProperty('Field');
    });

    it.todo('after 0.5: getSchema returns ColumnInfo[] and listTables returns TableInfo[]');

    // T0.3 — criterion 2 requires a *validation* error, not a driver syntax
    // error. A driver error would mean the string still reached the server.
    it('rejects a stacked statement in tableName before reaching the driver', async () => {
      await expect(db.getSchema('film; SELECT 1')).rejects.toThrow(InvalidIdentifierError);
    });

    it('rejects a backtick escape in tableName', async () => {
      await expect(db.getSchema('film`; DROP TABLE film; --')).rejects.toThrow(
        InvalidIdentifierError
      );
    });

    it('leaves the fixture intact after a rejected injection', async () => {
      const rows = await db.query('SELECT count(*) AS count FROM film');
      expect(Number(rows[0].count)).toBe(EXPECTED.film);
    });
  });

  describe('getRelations', () => {
    it('discovers Sakila foreign keys', async () => {
      const rels = await db.getRelations('sakila');
      expect(rels.length).toBeGreaterThan(10);

      const filmActor = rels.filter((r) => r.childTable === 'film_actor');
      const parents = filmActor.map((r) => r.parentTable).sort();
      expect(parents).toEqual(['actor', 'film']);
    });

    // T0.9 — previously required `databaseName`, so this needed an `as any`
    // cast and MysqlDatabase was not substitutable for Database.
    it('falls back to the configured database when called with no arg', async () => {
      const rels = await db.getRelations();
      expect(rels.length).toBeGreaterThan(10);
    });

    it('is callable through the Database base type without a cast', async () => {
      const base: Database = db;
      expect((await base.getRelations()).length).toBeGreaterThan(10);
    });
  });
});
