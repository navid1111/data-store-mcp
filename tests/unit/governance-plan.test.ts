/**
 * T1.4 — runtime half of the QueryPlan tests. The unforgeability half is
 * type-level, in tests/types/query-plan.test-types.ts.
 */

import { describe, it, expect } from 'vitest';
import { createQueryPlan } from '../../src/governance/plan.js';

describe('createQueryPlan', () => {
  it('carries the rewritten SQL and bound parameters', () => {
    const plan = createQueryPlan({
      sql: 'SELECT title FROM film WHERE rating = $1 LIMIT 10',
      params: ['PG-13'],
      dialect: 'postgres',
      appliedLimit: 10,
    });

    expect(plan.sql).toContain('LIMIT 10');
    expect(plan.params).toEqual(['PG-13']);
    expect(plan.dialect).toBe('postgres');
    expect(plan.appliedLimit).toBe(10);
  });

  it('defaults params and policies to empty', () => {
    const plan = createQueryPlan({ sql: 'SELECT 1', dialect: 'mysql', appliedLimit: 1 });
    expect(plan.params).toEqual([]);
    expect(plan.appliedPolicies).toEqual([]);
  });

  it('records applied policies for the audit record', () => {
    const plan = createQueryPlan({
      sql: 'SELECT 1',
      dialect: 'postgres',
      appliedLimit: 1,
      appliedPolicies: ['limit:1000', 'rlac:store_scope'],
    });
    expect(plan.appliedPolicies).toEqual(['limit:1000', 'rlac:store_scope']);
  });

  // An approved plan must not be editable between approval and execution:
  // otherwise the gate's guarantees describe a value that no longer exists.
  it('freezes the plan', () => {
    const plan = createQueryPlan({ sql: 'SELECT 1', dialect: 'postgres', appliedLimit: 5 });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(() => {
      (plan as unknown as { sql: string }).sql = 'DROP TABLE film';
    }).toThrow();
    expect(plan.sql).toBe('SELECT 1');
  });

  it('freezes params and policies too', () => {
    const plan = createQueryPlan({
      sql: 'SELECT 1',
      params: ['a'],
      dialect: 'postgres',
      appliedLimit: 5,
      appliedPolicies: ['p'],
    });
    expect(Object.isFrozen(plan.params)).toBe(true);
    expect(Object.isFrozen(plan.appliedPolicies)).toBe(true);
  });

  it('copies inputs so later mutation of the caller array cannot alter the plan', () => {
    const params: unknown[] = ['a'];
    const plan = createQueryPlan({
      sql: 'SELECT 1',
      params,
      dialect: 'postgres',
      appliedLimit: 5,
    });

    params.push('injected');
    expect(plan.params).toEqual(['a']);
  });

  it('adds no runtime brand property', () => {
    // The brand exists only in the type system, so a plan serializes cleanly
    // into an audit record.
    const plan = createQueryPlan({ sql: 'SELECT 1', dialect: 'postgres', appliedLimit: 5 });
    expect(Object.keys(plan).sort()).toEqual([
      'appliedLimit',
      'appliedPolicies',
      'dialect',
      'params',
      'sql',
    ]);
    expect(JSON.parse(JSON.stringify(plan)).sql).toBe('SELECT 1');
  });
});
