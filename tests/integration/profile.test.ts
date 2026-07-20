/**
 * T0.7 — column profiling against Pagila and Sakila.
 *
 * Both fixtures derive from the same dataset, so the expected statistics are
 * identical across engines — which makes cross-engine disagreement a real
 * signal rather than a fixture artefact.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Database } from '../../src/database-source.js';
import { PostgresDatabase } from '../../src/postgres.js';
import { MysqlDatabase } from '../../src/mysql.js';
import { isOrderedType, profileSqlColumns } from '../../src/sources/profile-sql.js';
import {
  InvalidIdentifierError,
  quoteMysqlIdentifier,
  quotePostgresIdentifier,
} from '../../src/identifiers.js';
import { PAGILA, SAKILA, EXPECTED } from '../helpers/sources.js';

const RATINGS = ['G', 'PG', 'PG-13', 'R', 'NC-17'];

interface Engine {
  label: string;
  make: () => Database;
  close: (db: Database) => Promise<void>;
}

const engines: Engine[] = [
  {
    label: 'postgres',
    make: () => new PostgresDatabase(PAGILA),
    close: async (db) => { await (db as any).pool?.end(); },
  },
  {
    label: 'mysql',
    make: () => new MysqlDatabase(SAKILA),
    close: async (db) => { await (db as any).connection?.end(); },
  },
];

describe.each(engines)('profile / $label', (engine) => {
  let db: Database;

  beforeAll(async () => {
    db = engine.make();
    await db.connect();
  }, 60_000);

  afterAll(async () => {
    await engine.close(db);
  });

  describe('low-cardinality columns', () => {
    it('reports distinct count and top values for film.rating', async () => {
      const [rating] = await db.profile('film', ['rating']);

      expect(rating.column).toBe('rating');
      expect(rating.distinctCount).toBe(RATINGS.length);
      expect(rating.topValues).toBeDefined();
      expect(rating.topValues!.map((v) => String(v.value)).sort()).toEqual(
        [...RATINGS].sort()
      );
    });

    it('sorts top values by descending frequency', async () => {
      const [rating] = await db.profile('film', ['rating']);
      const counts = rating.topValues!.map((v) => v.count);
      expect(counts).toEqual([...counts].sort((a, b) => b - a));
    });

    it('reports plausible counts', async () => {
      const [rating] = await db.profile('film', ['rating']);
      const counts = rating.topValues!.map((v) => v.count);

      expect(counts.every((c) => c > 0)).toBe(true);
      expect(counts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(EXPECTED.film);
    });
  });

  describe('high-cardinality columns', () => {
    // The point of the task: profiling a key must not return 1000 values into
    // the agent's context. Omitted, not truncated — so a caller can tell the
    // difference between "few values" and "too many to list".
    it('omits topValues for a primary key rather than truncating', async () => {
      const [id] = await db.profile('film', ['film_id']);

      expect(id.distinctCount).toBe(EXPECTED.film);
      expect(id.topValues).toBeUndefined();
    });

    it('respects a configured cardinality cutoff', async () => {
      const [withDefault] = await db.profile('film', ['rating']);
      expect(withDefault.topValues).toBeDefined();

      const [belowCutoff] = await db.profile('film', ['rating'], {
        maxDistinctForTopValues: 2,
      });
      expect(belowCutoff.topValues).toBeUndefined();
    });

    it('respects a configured top-value limit', async () => {
      const [rating] = await db.profile('film', ['rating'], { topValueLimit: 2 });
      expect(rating.topValues).toHaveLength(2);
    });
  });

  describe('null rate', () => {
    it('is 0 for a NOT NULL column', async () => {
      const [title] = await db.profile('film', ['title']);
      expect(title.nullRate).toBe(0);
    });

    it('is above 0 for a nullable column containing nulls', async () => {
      // film.original_language_id is null for every row in both fixtures.
      const [lang] = await db.profile('film', ['original_language_id']);
      expect(lang.nullRate).toBeGreaterThan(0);
      expect(lang.nullRate).toBeLessThanOrEqual(1);
    });
  });

  describe('min / max', () => {
    it('populates min and max for a numeric column', async () => {
      const [len] = await db.profile('film', ['length']);
      expect(len.min).toBeDefined();
      expect(len.max).toBeDefined();
      expect(Number(len.min)).toBeLessThan(Number(len.max));
    });

    it('omits min and max for a text column', async () => {
      const [title] = await db.profile('film', ['title']);
      expect(title.min).toBeUndefined();
      expect(title.max).toBeUndefined();
    });
  });

  describe('whole-table profiling', () => {
    it('profiles every column when none are named', async () => {
      const profiles = await db.profile('film');
      const columns = await db.getSchema('film');
      expect(profiles.map((p) => p.column).sort()).toEqual(
        columns.map((c) => c.name).sort()
      );
    });

    it('completes within the time budget', async () => {
      const started = Date.now();
      await db.profile('film');
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });

  describe('safety', () => {
    // Criterion 7: profiling must be read-only. Asserted directly on the SQL
    // issued rather than by provisioning a restricted role.
    it('issues only SELECT statements', async () => {
      const spy = vi.spyOn(db, 'query');
      await db.profile('film', ['rating', 'film_id']);

      expect(spy).toHaveBeenCalled();
      for (const [sql] of spy.mock.calls) {
        expect(String(sql).trimStart()).toMatch(/^SELECT/i);
      }
      spy.mockRestore();
    });

    it('ignores a column name that does not exist', async () => {
      expect(await db.profile('film', ['no_such_column'])).toEqual([]);
    });

    // profile() filters requested columns against getSchema first, so a
    // malicious name never survives that far. This drives profileSqlColumns
    // directly with a forged ColumnInfo — the only path by which an
    // unvalidated identifier could reach the generated SQL — and asserts the
    // quoting layer rejects it rather than interpolating.
    it('rejects a forged column name before it reaches SQL', async () => {
      const [real] = await db.getSchema('film');
      const forged = { ...real, name: "rating'; DROP TABLE film; --" };
      const issued: string[] = [];

      await expect(
        profileSqlColumns({
          quote: engine.label === 'postgres' ? quotePostgresIdentifier : quoteMysqlIdentifier,
          query: async (sql) => {
            issued.push(sql);
            return db.query(sql) as Promise<any>;
          },
          table: 'film',
          columns: [forged],
        })
      ).rejects.toThrow(InvalidIdentifierError);

      expect(issued).toHaveLength(0); // nothing was sent to the server
    });

    it('leaves the fixture intact after a rejected identifier', async () => {
      const rows = (await db.query('SELECT count(*) AS n FROM film')) as any[];
      expect(Number(rows[0].n)).toBe(EXPECTED.film);
    });
  });
});

describe('isOrderedType', () => {
  it.each(['integer', 'int', 'bigint', 'numeric(4,2)', 'date', 'timestamp without time zone', 'decimal', 'double precision', 'year'])(
    'treats %s as ordered',
    (t) => expect(isOrderedType(t)).toBe(true)
  );

  it.each(['text', 'character varying(255)', 'boolean', 'bytea', 'tsvector', 'ARRAY', 'USER-DEFINED', 'enum', 'json'])(
    'treats %s as unordered',
    (t) => expect(isOrderedType(t)).toBe(false)
  );
});
