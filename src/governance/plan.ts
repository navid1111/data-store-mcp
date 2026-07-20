/**
 * The only thing an adapter will execute (architecture.md §5, §7).
 *
 * `QueryPlan` carries a brand keyed on a `unique symbol` that this module does
 * **not** export. That makes the type unforgeable from outside: no object
 * literal can satisfy it, no cast short of `as unknown as QueryPlan` produces
 * one, and `Database.execute` accepts nothing else. The result is that
 * "governance cannot be bypassed" is a compile-time property rather than a
 * convention a future contributor has to remember.
 *
 * `createQueryPlan` is exported because the gate is spread over several
 * modules, but the boundary is enforced by tests/invariant/query-plan.test.ts,
 * which fails if anything outside src/governance/ mints a plan.
 */

import type { Dialect } from './parse.js';

declare const QUERY_PLAN_BRAND: unique symbol;

export interface QueryPlan {
    /** Rewritten SQL: limits injected, policies applied, values parameterised. */
    readonly sql: string;
    /** Bound parameters, positional. Never interpolated into `sql`. */
    readonly params: readonly unknown[];
    readonly dialect: Dialect;
    /** Row limit actually enforced, so a caller can tell truncation happened. */
    readonly appliedLimit: number;
    /** Names of policies applied during rewriting, for the audit record. */
    readonly appliedPolicies: readonly string[];
    /** Present only on plans built by governance. Not exported. */
    readonly [QUERY_PLAN_BRAND]: true;
}

export interface QueryPlanInput {
    sql: string;
    params?: readonly unknown[];
    dialect: Dialect;
    appliedLimit: number;
    appliedPolicies?: readonly string[];
}

/**
 * Mints a plan. Callable only from within src/governance/ — see the invariant
 * test. Everything here is frozen so a plan cannot be mutated after the gate
 * has approved it.
 */
export function createQueryPlan(input: QueryPlanInput): QueryPlan {
    const plan = {
        sql: input.sql,
        params: Object.freeze([...(input.params ?? [])]),
        dialect: input.dialect,
        appliedLimit: input.appliedLimit,
        appliedPolicies: Object.freeze([...(input.appliedPolicies ?? [])]),
    };

    // The brand exists only in the type system; nothing is added at runtime.
    return Object.freeze(plan) as unknown as QueryPlan;
}

/** Options an adapter honours while executing a plan. */
export interface ExecuteOptions {
    /** Milliseconds before the query is cancelled at the driver. Task 1.6. */
    timeoutMs?: number;
    /** Maximum serialized result size in bytes. Task 1.10. */
    maxBytes?: number;
}
