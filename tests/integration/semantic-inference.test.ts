import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ColumnInfo,
  Database,
  Row,
  TableInfo,
  TableRelation,
} from '../../src/database-source.js';
import { PostgresDatabase } from '../../src/postgres.js';
import { inferRelationships } from '../../src/semantic/inference.js';
import { PAGILA } from '../helpers/sources.js';

const SCHEMA = 'dsm_test_relationship_inference';
const TABLES = [
  'actor',
  'film',
  'film_actor',
  'orphan',
  'orphan_event',
  'typed_parent',
  'typed_event',
] as const;

let db: PostgresDatabase;
let scoped: Database;

beforeAll(async () => {
  db = new PostgresDatabase(PAGILA);
  await db.connect();
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.query(`CREATE SCHEMA ${SCHEMA}`);
  await db.query(`CREATE TABLE ${SCHEMA}.actor AS SELECT actor_id FROM public.actor`);
  await db.query(`ALTER TABLE ${SCHEMA}.actor ADD PRIMARY KEY (actor_id)`);
  await db.query(`CREATE TABLE ${SCHEMA}.film AS SELECT film_id FROM public.film`);
  await db.query(`ALTER TABLE ${SCHEMA}.film ADD PRIMARY KEY (film_id)`);
  await db.query(`
    CREATE TABLE ${SCHEMA}.film_actor AS
    SELECT actor_id, film_id FROM public.film_actor
  `);
  await db.query(`CREATE TABLE ${SCHEMA}.orphan (orphan_id integer PRIMARY KEY)`);
  await db.query(`INSERT INTO ${SCHEMA}.orphan VALUES (10001), (10002)`);
  await db.query(`CREATE TABLE ${SCHEMA}.orphan_event (orphan_id integer NOT NULL)`);
  await db.query(`INSERT INTO ${SCHEMA}.orphan_event VALUES (1), (2)`);
  await db.query(`CREATE TABLE ${SCHEMA}.typed_parent (typed_parent_id integer PRIMARY KEY)`);
  await db.query(`INSERT INTO ${SCHEMA}.typed_parent VALUES (1)`);
  await db.query(`CREATE TABLE ${SCHEMA}.typed_event (typed_parent_id text NOT NULL)`);
  await db.query(`INSERT INTO ${SCHEMA}.typed_event VALUES ('1')`);
  scoped = scratchDatabase(db);
}, 60_000);

afterAll(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
  await (db as any).pool?.end();
});

describe('undeclared relationship inference / Pagila scratch copy', () => {
  it('recovers film_actor parents through name, type, then value overlap', async () => {
    expect(await scoped.getRelations()).toEqual([]);
    const candidates = await inferRelationships(scoped, { sampleSize: 2_000 });

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromModel: 'film_actor',
        toModel: 'film',
        joinKeys: [{ fromColumn: 'film_id', toColumn: 'film_id' }],
        verified: false,
        provenance: 'profiling',
        confidence: expect.any(Number),
      }),
      expect.objectContaining({
        fromModel: 'film_actor',
        toModel: 'actor',
        joinKeys: [{ fromColumn: 'actor_id', toColumn: 'actor_id' }],
        verified: false,
        confidence: expect.any(Number),
      }),
    ]));
    expect(candidates.every((candidate) => candidate.confidence >= 0.6 && candidate.confidence <= 1))
      .toBe(true);
    expect(candidates.every((candidate) => candidate.evidence.overlapRatio > 0))
      .toBe(true);
  }, 60_000);

  it('rejects a same-named, type-compatible pair with zero value overlap', async () => {
    const candidates = await inferRelationships(scoped, { sampleSize: 2_000 });

    expect(candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ fromModel: 'orphan_event', toModel: 'orphan' }),
    ]));
  }, 60_000);

  it('rejects a naming match whose column types are incompatible', async () => {
    const candidates = await inferRelationships(scoped, { sampleSize: 2_000 });

    expect(candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ fromModel: 'typed_event', toModel: 'typed_parent' }),
    ]));
  }, 60_000);
});

function scratchDatabase(database: PostgresDatabase): Database {
  return {
    config: database.config,
    query: (sql: string, params?: unknown[]) => database.query(sql, params),
    listTables: async (): Promise<TableInfo[]> => TABLES.map((name) => ({
      name,
      schema: SCHEMA,
      kind: 'table',
    })),
    getSchema: async (tableName?: string): Promise<ColumnInfo[]> => {
      const rows = await database.query(`
        SELECT
          c.relname AS table,
          a.attname AS name,
          format_type(a.atttypid, a.atttypmod) AS data_type,
          NOT a.attnotnull AS nullable,
          a.attnum AS position,
          COALESCE(pk.hit, false) AS is_primary_key,
          COALESCE(uq.hit, false) AS is_unique
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a
          ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        LEFT JOIN LATERAL (
          SELECT true AS hit FROM pg_index i
          WHERE i.indrelid = c.oid AND i.indisprimary
            AND a.attnum = ANY (i.indkey::smallint[])
          LIMIT 1
        ) pk ON true
        LEFT JOIN LATERAL (
          SELECT true AS hit FROM pg_index i
          WHERE i.indrelid = c.oid AND i.indisunique
            AND array_length(i.indkey::smallint[], 1) = 1
            AND a.attnum = ANY (i.indkey::smallint[])
          LIMIT 1
        ) uq ON true
        WHERE n.nspname = $1 AND ($2::text IS NULL OR c.relname = $2)
        ORDER BY c.relname, a.attnum
      `, [SCHEMA, tableName ?? null]);
      return rows.map(toColumn);
    },
    getRelations: async (): Promise<TableRelation[]> => {
      const rows = await database.query(`
        SELECT
          kcu.table_name AS "childTable",
          kcu.column_name AS "childColumn",
          tc.constraint_name AS "constraintName",
          ccu.table_name AS "parentTable",
          ccu.column_name AS "parentColumn"
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
      `, [SCHEMA]);
      return rows as unknown as TableRelation[];
    },
  } as unknown as Database;
}

function toColumn(row: Row): ColumnInfo {
  return {
    table: String(row.table),
    name: String(row.name),
    dataType: String(row.data_type),
    nullable: Boolean(row.nullable),
    isPrimaryKey: Boolean(row.is_primary_key),
    isUnique: Boolean(row.is_unique),
    position: Number(row.position),
  };
}
