/**
 * PostgresDatabase against the Pagila sample database.
 *
 * Some tests below assert *current* behaviour that spec.md flags as a defect
 * (B7, B10). They are marked GAP and paired with an `it.todo` describing the
 * behaviour Phase 0 must deliver, so the suite documents the gap instead of
 * silently encoding it as correct.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresDatabase } from '../../src/postgres.js';
import { PAGILA, EXPECTED } from '../helpers/sources.js';

describe('PostgresDatabase / Pagila', () => {
  let db: PostgresDatabase;

  beforeAll(async () => {
    db = new PostgresDatabase(PAGILA);
    await db.connect();
  });

  afterAll(async () => {
    await (db as any).pool?.end();
  });

  describe('connect', () => {
    it('connects and runs a trivial query', async () => {
      const rows = await db.query('SELECT 1 AS ok');
      expect(rows).toEqual([{ ok: 1 }]);
    });
  });

  describe('query', () => {
    it('reads the expected fixture row counts', async () => {
      const [{ count }] = await db.query('SELECT count(*)::int AS count FROM film');
      expect(count).toBe(EXPECTED.film);
    });

    it('supports parameterized queries', async () => {
      const rows = await db.query(
        'SELECT title, rating FROM film WHERE rating = $1 ORDER BY title LIMIT 3',
        ['PG-13']
      );
      expect(rows).toHaveLength(3);
      expect(rows.every((r: any) => r.rating === 'PG-13')).toBe(true);
    });

    it('joins across a declared relationship', async () => {
      const rows = await db.query(`
        SELECT a.first_name, a.last_name, count(fa.film_id)::int AS films
        FROM actor a
        JOIN film_actor fa ON fa.actor_id = a.actor_id
        GROUP BY a.actor_id, a.first_name, a.last_name
        ORDER BY films DESC
        LIMIT 5
      `);
      expect(rows).toHaveLength(5);
      expect(rows[0].films).toBeGreaterThan(0);
    });
  });

  describe('getSchema', () => {
    it('returns columns for a named table', async () => {
      const cols = await db.getSchema('film');
      const names = cols.map((c: any) => c.column_name);

      expect(names).toContain('film_id');
      expect(names).toContain('title');
      expect(names).toContain('rental_rate');

      const title = cols.find((c: any) => c.column_name === 'title');
      expect(title.data_type).toMatch(/character varying|text/);
      expect(title.is_nullable).toBe('NO');
    });

    // GAP (spec B7): without a table name this returns every column in the
    // schema with no table attribution, so the result cannot be turned into a
    // model. `mdl bootstrap` is blocked on this.
    it('GAP B7: omits table_name when called without a table', async () => {
      const cols = await db.getSchema();
      expect(cols.length).toBeGreaterThan(50);
      expect(Object.keys(cols[0])).toEqual(['column_name', 'data_type', 'is_nullable']);
      expect(cols[0]).not.toHaveProperty('table_name');
    });

    it.todo('after 0.5: returns ColumnInfo[] including table, PK flag and comment');

    // GAP (spec B10): tableName is interpolated, not bound. This proves the
    // injection is reachable — a quoting fix must make this throw or return [].
    it('GAP B10: tableName is interpolated into SQL', async () => {
      const injected = await db.getSchema("film' OR '1'='1");
      expect(injected.length).toBeGreaterThan(0); // predicate defeated
    });

    it.todo('after 0.3: rejects or safely escapes a quote in tableName');
  });

  describe('getRelations', () => {
    it('discovers Pagila foreign keys', async () => {
      const rels = await db.getRelations();
      expect(rels.length).toBeGreaterThan(10);

      const filmActor = rels.filter((r) => r.childTable === 'film_actor');
      const parents = filmActor.map((r) => r.parentTable).sort();
      expect(parents).toEqual(['actor', 'film']);

      for (const r of rels) {
        expect(r.childTable).toBeTruthy();
        expect(r.childColumn).toBeTruthy();
        expect(r.parentTable).toBeTruthy();
        expect(r.parentColumn).toBeTruthy();
      }
    });
  });
});
