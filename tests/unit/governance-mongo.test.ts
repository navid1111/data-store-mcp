import { describe, expect, it } from 'vitest';
import {
  buildMongoPlan,
  DEFAULT_MONGO_LIMIT,
  MAX_MONGO_PIPELINE_STAGES,
} from '../../src/governance/mongo.js';

const query = (overrides: Record<string, unknown> = {}) => ({
  operation: 'find',
  collection: 'film',
  ...overrides,
});

describe('buildMongoPlan', () => {
  it.each(['deleteMany', 'insertOne', 'dropDatabase'])(
    'rejects the write operation %s',
    (operation) => {
      expect(() => buildMongoPlan(query({ operation }))).toThrowError(
        expect.objectContaining({ code: 'E_WRITE_FORBIDDEN' }),
      );
    },
  );

  it('rejects dropDatabase even though that operation has no collection', () => {
    expect(() => buildMongoPlan({ operation: 'dropDatabase' })).toThrowError(
      expect.objectContaining({ code: 'E_WRITE_FORBIDDEN' }),
    );
  });

  it.each(['$out', '$merge'])('rejects the write stage %s', (stage) => {
    expect(() =>
      buildMongoPlan(
        query({ operation: 'aggregate', pipeline: [{ $match: {} }, { [stage]: 'sink' }] }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'E_WRITE_FORBIDDEN' }));
  });

  it('rejects a write stage hidden in a nested pipeline', () => {
    expect(() =>
      buildMongoPlan(
        query({
          operation: 'aggregate',
          pipeline: [{ $facet: { unsafe: [{ $merge: 'sink' }] } }],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'E_WRITE_FORBIDDEN' }));
  });

  it('adds the default limit to an unbounded find', () => {
    const plan = buildMongoPlan(query());

    expect(plan.payload.limit).toBe(DEFAULT_MONGO_LIMIT);
    expect(plan.appliedLimit).toBe(DEFAULT_MONGO_LIMIT);
    expect(plan.appliedPolicies).toContain('mongo-read-only');
    expect(plan.appliedPolicies).toContain(`mongo-limit:${DEFAULT_MONGO_LIMIT}`);
  });

  it('preserves a smaller find limit and clamps one above the ceiling', () => {
    expect(buildMongoPlan(query({ limit: 7 })).payload.limit).toBe(7);
    expect(
      buildMongoPlan(query({ limit: 500 }), { defaultLimit: 10, maxLimit: 100 }).payload
        .limit,
    ).toBe(100);
  });

  it('appends a final limit to an aggregate pipeline', () => {
    const plan = buildMongoPlan(
      query({ operation: 'aggregate', pipeline: [{ $match: { rating: 'G' } }] }),
      { defaultLimit: 25 },
    );

    expect(plan.payload.pipeline).toEqual([
      { $match: { rating: 'G' } },
      { $limit: 25 },
    ]);
    expect(plan.appliedLimit).toBe(25);
  });

  it('uses the smallest caller aggregate limit as the final output cap', () => {
    const plan = buildMongoPlan(
      query({
        operation: 'aggregate',
        pipeline: [{ $limit: 4 }, { $unwind: '$actors' }],
      }),
      { defaultLimit: 25 },
    );

    expect(plan.payload.pipeline?.at(-1)).toEqual({ $limit: 4 });
    expect(plan.appliedLimit).toBe(4);
  });

  it('rejects a caller pipeline over the stage cap', () => {
    const pipeline = Array.from(
      { length: MAX_MONGO_PIPELINE_STAGES + 1 },
      () => ({ $match: {} }),
    );

    expect(() => buildMongoPlan(query({ operation: 'aggregate', pipeline }))).toThrowError(
      expect.objectContaining({
        code: 'E_POLICY_DENIED',
        detail: expect.objectContaining({ policy: 'mongo-pipeline-stages' }),
      }),
    );
  });

  it('allows countDocuments without inventing a limit', () => {
    const plan = buildMongoPlan(query({ operation: 'countDocuments' }));

    expect(plan.appliedLimit).toBeNull();
    expect(plan.payload).not.toHaveProperty('limit');
  });

  it('accepts a JSON payload and freezes the approved plan deeply', () => {
    const plan = buildMongoPlan(JSON.stringify(query({ filter: { rating: 'G' } })));

    expect(plan.payload.filter).toEqual({ rating: 'G' });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.payload)).toBe(true);
    expect(Object.isFrozen(plan.payload.filter)).toBe(true);
  });
});
