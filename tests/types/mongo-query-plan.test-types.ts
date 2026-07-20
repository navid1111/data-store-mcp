import { MongoDatabase } from '../../src/mongodb.js';
import { buildMongoPlan, type MongoQueryPlan } from '../../src/governance/mongo.js';

declare const db: MongoDatabase;

export const plan: MongoQueryPlan = buildMongoPlan({
  operation: 'find',
  collection: 'film',
});

export const ok = db.execute(plan);

// @ts-expect-error - Mongo execute rejects a raw payload
export const rejectsPayload = db.execute({ operation: 'find', collection: 'film' });

// @ts-expect-error - Mongo execute rejects a JSON string
export const rejectsString = db.execute('{"operation":"find","collection":"film"}');

// @ts-expect-error - the unexported brand cannot be forged
export const rejectsObjectLiteral: MongoQueryPlan = {
  payload: { operation: 'find', collection: 'film' },
  appliedLimit: 1000,
  appliedPolicies: [],
};

// @ts-expect-error - approved plans are immutable
plan.appliedLimit = 2;
