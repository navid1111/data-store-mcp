/**
 * MongoDatabase against a seeded fixture.
 *
 * There is no canonical Mongo equivalent of Pagila/Sakila, so the dataset is
 * seeded by tests/helpers/seed-mongo.ts in a shape that mirrors them.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoDatabase } from '../../src/mongodb.js';
import type { MongoConnectionConfig, Row } from '../../src/database-source.js';
import { MONGO } from '../helpers/sources.js';
import { seedMongo, SEEDED } from '../helpers/seed-mongo.js';

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
      ).rejects.toThrow(/Unsupported MongoDB operation/);
    });

    it('requires a field for distinct', async () => {
      await expect(
        db.query('', { operation: 'distinct', collection: 'film' })
      ).rejects.toThrow(/require a field/);
    });
  });

  describe('getSchema', () => {
    it('summarises a named collection', async () => {
      const [info] = await db.getSchema('film');
      expect(info.name).toBe('film');
      expect(info.estimatedDocumentCount).toBe(SEEDED.films);
      expect(info.sampleFields).toContain('title');
      expect(info.indexes.some((i: any) => i.unique)).toBe(true);
    });

    it('summarises every collection when called with no argument', async () => {
      const all = await db.getSchema();
      const names = all.map((c: any) => c.name).sort();
      expect(names).toEqual(['actor', 'film']);
    });

    // Field inference comes from a single sampled document, so an optional or
    // heterogeneous field is invisible. spec.md R3.8 (profiling) needs to
    // sample many documents, not one.
    it('GAP: infers fields from a single sampled document', async () => {
      const [info] = await db.getSchema('film');
      expect(info.sampleFields.length).toBeGreaterThan(0);
    });

    it.todo('after R3.8: infers a field union by sampling N documents');
  });

  describe('getRelations', () => {
    // Documents spec.md D2: relationships are unavailable for document stores
    // until Phase 4 maps $lookup / embedded documents into MDL.
    it('returns no relations (documented D2 limitation)', async () => {
      expect(await db.getRelations()).toEqual([]);
    });
  });
});
