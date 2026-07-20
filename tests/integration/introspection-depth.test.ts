/**
 * T0.6 — keys, defaults and comments.
 *
 * Comments are seeded on a scratch table rather than asserted against one the
 * fixture happens to ship: Pagila and Sakila do not reliably carry column
 * comments, and depending on that would make the suite fragile across fixture
 * versions. Per test.md §3 the scratch object is prefixed `dsm_test_` and
 * dropped in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from '../../src/database-source.js';
import { PostgresDatabase } from '../../src/postgres.js';
import { MysqlDatabase } from '../../src/mysql.js';
import { PAGILA, SAKILA } from '../helpers/sources.js';

const SCRATCH = 'dsm_test_introspection';
const COLUMN_COMMENT = 'dsm_test column comment';
const TABLE_COMMENT = 'dsm_test table comment';

interface Engine {
  label: string;
  make: () => Database;
  create: string[];
  close: (db: Database) => Promise<void>;
}

const engines: Engine[] = [
  {
    label: 'postgres',
    make: () => new PostgresDatabase(PAGILA),
    create: [
      `CREATE TABLE ${SCRATCH} (
         id           integer PRIMARY KEY,
         labeled      text,
         plain        text,
         with_default integer DEFAULT 42,
         uniq         text UNIQUE
       )`,
      `COMMENT ON TABLE ${SCRATCH} IS '${TABLE_COMMENT}'`,
      `COMMENT ON COLUMN ${SCRATCH}.labeled IS '${COLUMN_COMMENT}'`,
    ],
    close: async (db) => { await (db as any).pool?.end(); },
  },
  {
    label: 'mysql',
    make: () => new MysqlDatabase(SAKILA),
    create: [
      `CREATE TABLE ${SCRATCH} (
         id           INT PRIMARY KEY,
         labeled      TEXT COMMENT '${COLUMN_COMMENT}',
         plain        TEXT,
         with_default INT DEFAULT 42,
         uniq         VARCHAR(64) UNIQUE
       ) COMMENT='${TABLE_COMMENT}'`,
    ],
    close: async (db) => { await (db as any).connection?.end(); },
  },
];

describe.each(engines)('introspection depth / $label', (engine) => {
  let db: Database;

  beforeAll(async () => {
    db = engine.make();
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS ${SCRATCH}`);
    for (const statement of engine.create) {
      await db.query(statement);
    }
  }, 60_000);

  afterAll(async () => {
    await db.query(`DROP TABLE IF EXISTS ${SCRATCH}`).catch(() => undefined);
    await engine.close(db);
  });

  describe('primary keys', () => {
    it('marks the primary key and only the primary key', async () => {
      const cols = await db.getSchema('film');
      expect(cols.find((c) => c.name === 'film_id')!.isPrimaryKey).toBe(true);
      expect(cols.find((c) => c.name === 'title')!.isPrimaryKey).toBe(false);
    });

    // The FAIL criterion for T0.6: a composite key must mark *both* columns.
    // Reading only the first key column is the classic introspection bug, and
    // it silently breaks relationship cardinality inference later.
    it('marks every column of a composite primary key', async () => {
      const cols = await db.getSchema('film_actor');
      const pk = cols.filter((c) => c.isPrimaryKey).map((c) => c.name).sort();
      expect(pk).toEqual(['actor_id', 'film_id']);
    });
  });

  describe('uniqueness', () => {
    it('reports a single-column unique constraint', async () => {
      const cols = await db.getSchema(SCRATCH);
      expect(cols.find((c) => c.name === 'uniq')!.isUnique).toBe(true);
    });

    it('does not mark an unconstrained column as unique', async () => {
      const cols = await db.getSchema(SCRATCH);
      expect(cols.find((c) => c.name === 'plain')!.isUnique).toBe(false);
    });

    it('finds at least one unique column in the fixture', async () => {
      const cols = await db.getSchema();
      expect(cols.some((c) => c.isUnique)).toBe(true);
    });
  });

  describe('defaults', () => {
    // Both directions: a stub returning undefined for everything would pass
    // the negative case alone.
    it('reports a column default when one exists', async () => {
      const cols = await db.getSchema(SCRATCH);
      expect(cols.find((c) => c.name === 'with_default')!.defaultValue).toMatch(/42/);
    });

    it('omits defaultValue when there is none', async () => {
      const cols = await db.getSchema(SCRATCH);
      expect(cols.find((c) => c.name === 'plain')!.defaultValue).toBeUndefined();
    });
  });

  describe('comments', () => {
    it('round-trips a column comment', async () => {
      const cols = await db.getSchema(SCRATCH);
      expect(cols.find((c) => c.name === 'labeled')!.comment).toBe(COLUMN_COMMENT);
    });

    // Absent must be `undefined`, not '' or null: an empty string is truthy
    // enough to look like documentation to a bootstrap pipeline.
    it('omits comment when there is none', async () => {
      const cols = await db.getSchema(SCRATCH);
      const plain = cols.find((c) => c.name === 'plain')!;
      expect(plain.comment).toBeUndefined();
      expect(plain).not.toHaveProperty('comment');
    });

    it('round-trips a table comment', async () => {
      const tables = await db.listTables();
      expect(tables.find((t) => t.name === SCRATCH)!.comment).toBe(TABLE_COMMENT);
    });

    it('omits table comment when there is none', async () => {
      const tables = await db.listTables();
      expect(tables.find((t) => t.name === 'film')!.comment).toBeUndefined();
    });
  });

  describe('nullability', () => {
    it('reports nullable as a boolean in both directions', async () => {
      const cols = await db.getSchema(SCRATCH);
      expect(cols.find((c) => c.name === 'id')!.nullable).toBe(false);
      expect(cols.find((c) => c.name === 'plain')!.nullable).toBe(true);
    });
  });

  describe('position', () => {
    it('orders columns by their declared position', async () => {
      const cols = await db.getSchema(SCRATCH);
      expect(cols.map((c) => c.name)).toEqual([
        'id',
        'labeled',
        'plain',
        'with_default',
        'uniq',
      ]);
      expect(cols.map((c) => c.position)).toEqual([1, 2, 3, 4, 5]);
    });
  });
});
