/**
 * T1.4 — the brand must make QueryPlan unforgeable.
 *
 * Verified by `npm run typecheck`. Each `@ts-expect-error` must fire, so if
 * the brand were removed these would become "unused directive" errors and the
 * build would fail.
 */

import type { QueryPlan } from '../../src/governance/plan.js';
import { createQueryPlan } from '../../src/governance/plan.js';
import { PostgresDatabase } from '../../src/postgres.js';

declare const db: PostgresDatabase;

// A plan from the factory is the only accepted input.
export const plan: QueryPlan = createQueryPlan({
    sql: 'SELECT title FROM film LIMIT $1',
    params: [10],
    dialect: 'postgres',
    appliedLimit: 10,
});

export const ok = db.execute(plan);

// @ts-expect-error - execute() does not accept raw SQL
export const rejectsString = db.execute('SELECT * FROM film');

// @ts-expect-error - an object literal cannot satisfy the brand
export const rejectsLiteral = db.execute({
    sql: 'SELECT * FROM film',
    params: [],
    dialect: 'postgres',
    appliedLimit: 1000,
    appliedPolicies: [],
});

// @ts-expect-error - the brand is not exported, so it cannot be supplied
export const rejectsForgedBrand: QueryPlan = {
    sql: 'SELECT 1',
    params: [],
    dialect: 'postgres',
    appliedLimit: 1,
    appliedPolicies: [],
};

// @ts-expect-error - execute() rejects undefined
export const rejectsUndefined = db.execute(undefined);

// Plan fields are readonly: an approved plan cannot be edited before it runs.
// @ts-expect-error - `sql` is readonly
plan.sql = 'SELECT * FROM film';

// @ts-expect-error - `appliedLimit` is readonly
plan.appliedLimit = 999_999;

// Reading is fine.
export const limit: number = plan.appliedLimit;
export const policies: readonly string[] = plan.appliedPolicies;
