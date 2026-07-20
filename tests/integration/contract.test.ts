/**
 * T0.5 — cross-adapter introspection contract.
 *
 * One suite, run against all three adapters, asserting they return *identical
 * shapes*. This is deliberately not three per-adapter suites: the whole point
 * of the task is uniformity, and separate suites are exactly how B9/B13 arose
 * in the first place (Postgres returning `column_name`, MySQL returning
 * `Field`, Mongo returning collection summaries).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from '../../src/database-source.js';
import { PostgresDatabase } from '../../src/postgres.js';
import { MysqlDatabase } from '../../src/mysql.js';
import { MongoDatabase } from '../../src/mongodb.js';
import { PAGILA, SAKILA, MONGO } from '../helpers/sources.js';
import { seedMongo } from '../helpers/seed-mongo.js';

const COLUMN_KEYS = [
  'table',
  'name',
  'dataType',
  'nullable',
  'isPrimaryKey',
  'isUnique',
  'position',
] as const;

interface Adapter {
  label: string;
  make: () => Database;
  /** A table/collection present in this fixture. */
  table: string;
  /** A second table, to prove multi-table attribution. */
  otherTable: string;
  /**
   * Whether the adapter validates the table identifier. SQL engines must
   * (task 0.3): the name reaches a query string. Mongo must not — a
   * collection name is passed to the driver as a value, never interpolated,
   * and legal Mongo names contain characters a SQL identifier cannot.
   */
  validatesIdentifiers: boolean;
  close: (db: Database) => Promise<void>;
}

const adapters: Adapter[] = [
  {
    label: 'postgres/pagila',
    make: () => new PostgresDatabase(PAGILA),
    table: 'film',
    otherTable: 'actor',
    validatesIdentifiers: true,
    close: async (db) => { await (db as any).pool?.end(); },
  },
  {
    label: 'mysql/sakila',
    make: () => new MysqlDatabase(SAKILA),
    table: 'film',
    otherTable: 'actor',
    validatesIdentifiers: true,
    close: async (db) => { await (db as any).connection?.end(); },
  },
  {
    label: 'mongodb/seeded',
    make: () => new MongoDatabase(MONGO),
    table: 'film',
    otherTable: 'actor',
    validatesIdentifiers: false,
    close: async (db) => { await (db as any).client?.close(); },
  },
];

describe.each(adapters)('introspection contract / $label', (adapter) => {
  let db: Database;

  beforeAll(async () => {
    if (adapter.label.startsWith('mongodb')) {
      await seedMongo();
    }
    db = adapter.make();
    await db.connect();
  }, 60_000);

  afterAll(async () => {
    await adapter.close(db);
  });

  describe('listTables', () => {
    it('returns TableInfo[] including the fixture tables', async () => {
      const tables = await db.listTables();
      const names = tables.map((t) => t.name);

      expect(names).toContain(adapter.table);
      expect(names).toContain(adapter.otherTable);
    });

    it('never returns columns', async () => {
      // B9: MySQL used to return table names from getSchema() and columns from
      // getSchema(name) — the same method with two different return types.
      const [first] = await db.listTables();
      expect(first).not.toHaveProperty('dataType');
      expect(first).not.toHaveProperty('Field');
      expect(first).not.toHaveProperty('column_name');
    });

    it('reports a valid kind for every table', async () => {
      const tables = await db.listTables();
      for (const t of tables) {
        expect(['table', 'view']).toContain(t.kind);
        expect(typeof t.name).toBe('string');
      }
    });
  });

  describe('getSchema(table)', () => {
    it('returns ColumnInfo with identical keys across adapters', async () => {
      const cols = await db.getSchema(adapter.table);
      expect(cols.length).toBeGreaterThan(0);

      for (const key of COLUMN_KEYS) {
        expect(cols[0]).toHaveProperty(key);
      }
      // The engine-native keys must be gone (B13).
      expect(cols[0]).not.toHaveProperty('column_name');
      expect(cols[0]).not.toHaveProperty('Field');
      expect(cols[0]).not.toHaveProperty('DATA_TYPE');
    });

    it('attributes every column to the requested table', async () => {
      const cols = await db.getSchema(adapter.table);
      expect(cols.every((c) => c.table === adapter.table)).toBe(true);
    });

    it('uses the documented value types', async () => {
      const [c] = await db.getSchema(adapter.table);
      expect(typeof c.table).toBe('string');
      expect(typeof c.name).toBe('string');
      expect(typeof c.dataType).toBe('string');
      // B13: MySQL reported 'YES'/'NO' strings, Postgres reported them too.
      expect(typeof c.nullable).toBe('boolean');
      expect(typeof c.isPrimaryKey).toBe('boolean');
      expect(typeof c.isUnique).toBe('boolean');
      expect(typeof c.position).toBe('number');
    });

    it.runIf(adapter.validatesIdentifiers)('rejects an invalid table identifier', async () => {
      await expect(db.getSchema("film' OR '1'='1")).rejects.toThrow();
    });

    it.runIf(!adapter.validatesIdentifiers)('returns nothing for an unknown collection', async () => {
      // Mongo does not validate: the name never reaches a query string.
      expect(await db.getSchema('no_such_collection_xyz')).toEqual([]);
    });
  });

  describe('getSchema()', () => {
    it('returns columns for every table, each carrying its own table', async () => {
      // B7: this call used to lose table attribution entirely.
      const cols = await db.getSchema();
      const tables = new Set(cols.map((c) => c.table));

      expect(tables.size).toBeGreaterThan(1);
      expect(tables).toContain(adapter.table);
      expect(tables).toContain(adapter.otherTable);
      expect(cols.every((c) => typeof c.table === 'string' && c.table.length > 0)).toBe(true);
    });

    it('is consistent with getSchema(table)', async () => {
      const all = await db.getSchema();
      const one = await db.getSchema(adapter.table);

      const fromAll = all
        .filter((c) => c.table === adapter.table)
        .map((c) => c.name)
        .sort();
      expect(fromAll).toEqual(one.map((c) => c.name).sort());
    });
  });
});
