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
import { InvalidIdentifierError } from '../../src/identifiers.js';
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
      const names = cols.map((c) => c.name);

      expect(names).toContain('film_id');
      expect(names).toContain('title');
      expect(names).toContain('rental_rate');

      const title = cols.find((c) => c.name === 'title');
      expect(title).toBeDefined();
      expect(title!.dataType).toMatch(/character varying|text/);
      expect(title!.nullable).toBe(false);
    });

    // T0.5 — this call previously lost table attribution entirely (B7).
    it('attributes every column when called without a table', async () => {
      const cols = await db.getSchema();
      expect(cols.length).toBeGreaterThan(50);
      expect(new Set(cols.map((c) => c.table)).size).toBeGreaterThan(5);
    });

    it('reports Pagila primary keys', async () => {
      const cols = await db.getSchema('film');
      const pk = cols.filter((c) => c.isPrimaryKey).map((c) => c.name);
      expect(pk).toEqual(['film_id']);
    });

    // T0.3 — the injection that GAP B10 previously demonstrated.
    it('rejects an injected predicate in tableName', async () => {
      await expect(db.getSchema("film' OR '1'='1")).rejects.toThrow(InvalidIdentifierError);
    });

    it('rejects a stacked statement in tableName', async () => {
      await expect(db.getSchema('film; SELECT 1')).rejects.toThrow(InvalidIdentifierError);
    });

    it('binds tableName rather than interpolating it', async () => {
      // A syntactically valid identifier for a table that does not exist must
      // come back empty, not error — proving the value is bound, not injected.
      const cols = await db.getSchema('no_such_table_xyz');
      expect(cols).toEqual([]);
    });
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
