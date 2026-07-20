/**
 * MongoDatabase against a seeded fixture.
 *
 * There is no canonical Mongo equivalent of Pagila/Sakila, so the dataset is
 * seeded by tests/helpers/seed-mongo.ts in a shape that mirrors them.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoDatabase } from '../../src/mongodb.js';
import type { MongoConnectionConfig, Row } from '../../src/database-source.js';
import { MONGO } from '../helpers/sources.js';
import { seedMongo, SEEDED } from '../helpers/seed-mongo.js';
import { buildMongoPlan } from '../../src/governance/mongo.js';
import { bootstrapMdl } from '../../src/semantic/bootstrap.js';

describe('MongoDatabase / seeded fixture', () => {
  let db: MongoDatabase;

  beforeAll(async () => {
    await seedMongo();
    db = new MongoDatabase(MONGO);
    await db.connect();
  }, 60_000);

  afterAll(async () => {
    await (db as any).client?.close();
  });

  describe('connect', () => {
    it('rejects a config missing uri or database', async () => {
      // Cast is deliberate: the type now forbids this, but the runtime guard
      // must still hold because configs can arrive from untyped JSON.
      const bad = new MongoDatabase({
        id: 'bad',
        type: 'mongodb',
        options: {},
      } as unknown as MongoConnectionConfig);
      await expect(bad.connect()).rejects.toThrow(/requires both uri and database/);
    });
  });

  describe('query', () => {
    it('runs find with a filter and limit', async () => {
      const rows = (await db.query('', {
        operation: 'find',
        collection: 'film',
        filter: { rating: 'G' },
        limit: 3,
      })) as Row[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(3);
      expect(rows.every((r: any) => r.rating === 'G')).toBe(true);
    });

    it('runs countDocuments', async () => {
      const count = await db.query('', { operation: 'countDocuments', collection: 'film' });
      expect(count).toBe(SEEDED.films);
    });

    it('runs an aggregate pipeline', async () => {
      const rows = (await db.query('', {
        operation: 'aggregate',
        collection: 'film',
        pipeline: [
          { $group: { _id: '$rating', n: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
      })) as Array<{ _id: string; n: number }>;
      expect(rows.length).toBeGreaterThan(1);
      expect(rows.reduce((sum, r) => sum + r.n, 0)).toBe(SEEDED.films);
    });

    it('runs distinct', async () => {
      const values = (await db.query('', {
        operation: 'distinct',
        collection: 'film',
        field: 'rating',
      })) as string[];
      expect(values.length).toBeGreaterThan(1);
    });

    it('accepts a JSON string payload', async () => {
      const count = await db.query(
        JSON.stringify({ operation: 'countDocuments', collection: 'actor' })
      );
      expect(count).toBe(SEEDED.actors);
    });

    it('rejects an unsupported operation', async () => {
      await expect(
        db.query('', { operation: 'dropDatabase', collection: 'film' })
      ).rejects.toMatchObject({ code: 'E_WRITE_FORBIDDEN' });
    });

    it('requires a field for distinct', async () => {
      await expect(
        db.query('', { operation: 'distinct', collection: 'film' })
      ).rejects.toThrow(/require a field/);
    });
  });

  describe('governance gate', () => {
    it('enforces the default find limit in the live driver', async () => {
      const plan = buildMongoPlan(
        { operation: 'find', collection: 'film', sort: { film_id: 1 } },
        { defaultLimit: 3 },
      );
      const rows = (await db.execute(plan)) as Row[];

      expect(rows).toHaveLength(3);
      expect(plan.payload.limit).toBe(3);
    });

    it.each(['deleteMany', 'insertOne', 'dropDatabase'])(
      'refuses %s and leaves the fixture intact',
      async (operation) => {
        await expect(
          db.query('', { operation, collection: 'film' }),
        ).rejects.toMatchObject({ code: 'E_WRITE_FORBIDDEN' });

        expect(
          await db.query('', { operation: 'countDocuments', collection: 'film' }),
        ).toBe(SEEDED.films);
      },
    );

    it.each(['$out', '$merge'])('refuses an aggregate containing %s', async (stage) => {
      await expect(
        db.query('', {
          operation: 'aggregate',
          collection: 'film',
          pipeline: [{ $match: {} }, { [stage]: 'dsm_test_forbidden_output' }],
        }),
      ).rejects.toMatchObject({ code: 'E_WRITE_FORBIDDEN' });

      expect((await db.listTables()).map((table) => table.name)).not.toContain(
        'dsm_test_forbidden_output',
      );
    });

    it('rejects an aggregate pipeline over the configured stage cap', () => {
      const pipeline = Array.from({ length: 4 }, () => ({ $match: {} }));

      expect(() =>
        buildMongoPlan(
          { operation: 'aggregate', collection: 'film', pipeline },
          { maxPipelineStages: 3 },
        ),
      ).toThrowError(expect.objectContaining({ code: 'E_POLICY_DENIED' }));
    });

    it('allows countDocuments without a limit', async () => {
      const plan = buildMongoPlan({ operation: 'countDocuments', collection: 'film' });

      expect(plan.appliedLimit).toBeNull();
      await expect(db.execute(plan)).resolves.toBe(SEEDED.films);
    });

    it('stops a cursor when its serialized rows cross the byte cap', async () => {
      const plan = buildMongoPlan({ operation: 'find', collection: 'film' });

      await expect(db.execute(plan, { maxBytes: 100 })).rejects.toMatchObject({
        code: 'E_RESULT_TOO_LARGE',
        detail: {
          limit: 100,
          actual: expect.any(Number),
        },
      });

      const count = buildMongoPlan({ operation: 'countDocuments', collection: 'film' });
      await expect(db.execute(count, { maxBytes: 100 })).resolves.toBe(SEEDED.films);
    });
  });

  describe('listTables', () => {
    it('returns the seeded collections with row estimates', async () => {
      const tables = await db.listTables();
      expect(tables.map((t) => [t.name, t.kind])).toEqual(expect.arrayContaining([
        ['actor', 'table'],
        ['film', 'table'],
        ['film_actor_lookup', 'view'],
      ]));

      const film = tables.find((t) => t.name === 'film');
      expect(film!.estimatedRowCount).toBe(SEEDED.films);
      expect(film!.kind).toBe('table');
      expect(tables.find((t) => t.name === 'film_actor_lookup')!.estimatedRowCount)
        .toBeUndefined();
    });
  });

  describe('getSchema', () => {
    it('derives ColumnInfo for a named collection', async () => {
      const cols = await db.getSchema('film');
      const names = cols.map((c) => c.name);

      expect(names).toContain('title');
      expect(names).toContain('rating');
      expect(cols.every((c) => c.table === 'film')).toBe(true);
    });

    it('marks _id as the primary key', async () => {
      const cols = await db.getSchema('film');
      const id = cols.find((c) => c.name === '_id');
      expect(id!.isPrimaryKey).toBe(true);
      expect(id!.isUnique).toBe(true);
    });

    it('marks a unique-indexed field as unique', async () => {
      const cols = await db.getSchema('film');
      expect(cols.find((c) => c.name === 'film_id')!.isUnique).toBe(true);
      expect(cols.find((c) => c.name === 'title')!.isUnique).toBe(false);
    });

    it('covers every collection when called with no argument', async () => {
      const cols = await db.getSchema();
      expect(new Set(cols.map((c) => c.table)).size).toBe(3);
    });

    it('infers optional fields and type unions by sampling many documents', async () => {
      const cols = await db.getSchema('film');
      expect(cols.find((c) => c.name === 'festival_award')).toEqual(
        expect.objectContaining({ dataType: 'string', nullable: true }),
      );
      expect(cols.find((c) => c.name === 'catalog_code')!.dataType)
        .toBe('number | string');
    });

    it('maps embedded documents to dotted nested columns', async () => {
      const cols = await db.getSchema('film');
      expect(cols.find((c) => c.name === 'actors')!.dataType).toBe('array');
      expect(cols.find((c) => c.name === 'actors.actor_id')!.dataType)
        .toBe('array<number>');
      expect(cols.find((c) => c.name === 'actors.full_name')!.dataType)
        .toBe('array<string>');
      expect(cols.find((c) => c.name === 'metadata.language')!.dataType).toBe('string');
      expect(cols.find((c) => c.name === 'metadata.dimensions.runtime_minutes')!.dataType)
        .toBe('number');
    });
  });

  describe('getRelations', () => {
    it('maps a view $lookup to the shared relationship contract', async () => {
      expect(await db.getRelations()).toEqual([{
        childTable: 'film',
        childColumn: 'lead_actor_id',
        constraintName: 'lookup:film_actor_lookup:lead_actor',
        parentTable: 'actor',
        parentColumn: 'actor_id',
      }]);
    });
  });

  describe('Mongo to MDL mapping', () => {
    it('bootstraps sampled fields, nested columns, unions, and lookups', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'data-store-mcp-mongo-mdl-'));
      try {
        const outputPath = join(directory, 'mongo.yml');
        const result = await bootstrapMdl(db, {
          source: MONGO.id,
          outputPath,
        });
        const film = result.document.models.find((model) => model.name === 'film');

        expect(result.document.models.map((model) => model.name).sort())
          .toEqual(['actor', 'film']);
        expect(film?.columns.find((column) => column.name === 'festival_award')?.nullable)
          .toBe(true);
        expect(film?.columns.find((column) => column.name === 'catalog_code')?.dataType)
          .toBe('number | string');
        expect(film?.columns.find((column) => column.name === 'actors.actor_id')?.dataType)
          .toBe('array<number>');
        expect(result.document.relationships).toEqual([
          expect.objectContaining({
            fromModel: 'film',
            toModel: 'actor',
            cardinality: 'many-to-one',
            joinKeys: [{ fromColumn: 'lead_actor_id', toColumn: 'actor_id' }],
            provenance: 'introspection',
            verified: false,
          }),
        ]);

        const second = await bootstrapMdl(db, { source: MONGO.id, outputPath });
        expect(second.changed).toBe(false);
        expect(second.yaml).toBe(result.yaml);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
});
