/**
 * T1.5 — row-limit injection.
 *
 * Assertions are on the parsed AST and on the plan, never on
 * `sql.includes('LIMIT')` — a substring check would pass for a limit appended
 * after a trailing comment, which is exactly the failure being guarded against.
 */

import { describe, it, expect } from 'vitest';
import { parseSql, type Dialect } from '../../src/governance/parse.js';
import { applyRowLimit, DEFAULT_LIMITS } from '../../src/governance/limit.js';
import { buildPlan } from '../../src/governance/gate.js';

const dialects: Dialect[] = ['postgres', 'mysql'];

/** Reads back the limit the AST actually carries, per the separator rules. */
function limitOf(sql: string, dialect: Dialect): number | null {
  let statement = parseSql(sql, dialect).statements[0];
  while (statement._next) statement = statement._next as typeof statement;

  const limit = statement.limit as
    | { seperator?: string; value?: Array<{ value?: unknown }> }
    | null;
  if (!limit?.value?.length) return null;

  const index =
    limit.seperator === ',' ? (limit.value.length >= 2 ? 1 : 0)
    : limit.seperator === 'offset' ? (limit.value.length >= 2 ? 0 : -1)
    : 0;

  return index < 0 ? null : Number(limit.value[index].value);
}

describe.each(dialects)('applyRowLimit / %s', (dialect) => {
  const rewrite = (sql: string, opts?: Parameters<typeof applyRowLimit>[1]) => {
    const parsed = parseSql(sql, dialect);
    const applied = applyRowLimit(parsed.statements[0], opts);
    return { applied, statement: parsed.statements[0] };
  };

  it('injects the default limit when the query has none', () => {
    const { applied } = rewrite('SELECT * FROM film');
    expect(applied).toBe(DEFAULT_LIMITS.defaultLimit);
  });

  it('injects into the AST, not by string concatenation', () => {
    const plan = buildPlan('SELECT * FROM film', { dialect });
    // Re-parsing the generated SQL must show one limit of the right value.
    expect(limitOf(plan.sql, dialect)).toBe(DEFAULT_LIMITS.defaultLimit);
    expect(plan.sql.match(/limit/gi)?.length).toBe(1);
  });

  it('preserves a smaller caller limit', () => {
    const { applied } = rewrite('SELECT * FROM film LIMIT 10');
    expect(applied).toBe(10);
  });

  it('clamps a larger caller limit to the ceiling', () => {
    const { applied } = rewrite('SELECT * FROM film LIMIT 999999');
    expect(applied).toBe(DEFAULT_LIMITS.maxLimit);
  });

  it('honours configured limits', () => {
    expect(rewrite('SELECT * FROM film', { defaultLimit: 25 }).applied).toBe(25);
    expect(rewrite('SELECT * FROM film LIMIT 500', { maxLimit: 100 }).applied).toBe(100);
  });

  it('never exceeds the ceiling even when the default is larger', () => {
    expect(rewrite('SELECT * FROM film', { defaultLimit: 5000, maxLimit: 100 }).applied).toBe(100);
  });

  describe('offset forms', () => {
    // Reading operand 0 unconditionally would clamp the offset here.
    it('clamps the count, not the offset, in LIMIT n OFFSET m', () => {
      const plan = buildPlan('SELECT * FROM film LIMIT 999999 OFFSET 20', { dialect });
      expect(plan.appliedLimit).toBe(DEFAULT_LIMITS.maxLimit);
      expect(plan.sql).toMatch(/OFFSET 20/i);
    });

    it('preserves a small count with an offset', () => {
      const plan = buildPlan('SELECT * FROM film LIMIT 5 OFFSET 20', { dialect });
      expect(plan.appliedLimit).toBe(5);
    });
  });

  describe('queries that would break string appending', () => {
    it('handles a trailing semicolon', () => {
      const plan = buildPlan('SELECT * FROM film;', { dialect });
      expect(limitOf(plan.sql, dialect)).toBe(DEFAULT_LIMITS.defaultLimit);
    });

    it('handles a trailing line comment', () => {
      const plan = buildPlan('SELECT * FROM film -- all of them', { dialect });
      expect(limitOf(plan.sql, dialect)).toBe(DEFAULT_LIMITS.defaultLimit);
    });

    it('handles an existing ORDER BY', () => {
      const plan = buildPlan('SELECT * FROM film ORDER BY title', { dialect });
      expect(limitOf(plan.sql, dialect)).toBe(DEFAULT_LIMITS.defaultLimit);
      expect(plan.sql).toMatch(/ORDER BY/i);
    });
  });

  describe('unions', () => {
    // A UNION's limit belongs to the union, not to an arm. Limiting each arm
    // would change the result set.
    it('limits the union as a whole', () => {
      const plan = buildPlan('SELECT title FROM film UNION SELECT title FROM film', { dialect });
      expect(plan.appliedLimit).toBe(DEFAULT_LIMITS.defaultLimit);
      expect(plan.sql.match(/limit/gi)?.length).toBe(1);
    });

    it('clamps an existing union limit', () => {
      const plan = buildPlan(
        'SELECT title FROM film UNION SELECT title FROM film LIMIT 999999',
        { dialect }
      );
      expect(plan.appliedLimit).toBe(DEFAULT_LIMITS.maxLimit);
    });
  });

  describe('subqueries', () => {
    // Deliberately NOT limited: `WHERE x IN (SELECT ...)` with a truncated
    // subquery returns silently wrong rows. Only the outer statement is
    // limited. See the note in test.md T1.5.
    it('leaves a subquery unlimited', () => {
      const plan = buildPlan(
        'SELECT title FROM film WHERE film_id IN (SELECT film_id FROM film_actor)',
        { dialect }
      );
      expect(plan.sql.match(/limit/gi)?.length).toBe(1);
      expect(plan.appliedLimit).toBe(DEFAULT_LIMITS.defaultLimit);
    });
  });
});

describe('buildPlan', () => {
  it('reports the applied limit and policies on the plan', () => {
    const plan = buildPlan('SELECT * FROM film', { dialect: 'postgres' });
    expect(plan.appliedLimit).toBe(DEFAULT_LIMITS.defaultLimit);
    expect(plan.appliedPolicies).toContain('read-only');
    expect(plan.appliedPolicies).toContain(`limit:${DEFAULT_LIMITS.defaultLimit}`);
  });

  it('carries caller parameters onto the plan', () => {
    const plan = buildPlan('SELECT * FROM film WHERE rating = $1', {
      dialect: 'postgres',
      params: ['PG-13'],
    });
    expect(plan.params).toEqual(['PG-13']);
  });

  it('refuses a write before rewriting it', () => {
    expect(() => buildPlan('DELETE FROM film', { dialect: 'postgres' })).toThrow(
      /not permitted/
    );
  });

  it('refuses multi-statement input', () => {
    try {
      buildPlan('SELECT 1 AS n; DELETE FROM film', { dialect: 'postgres' });
      throw new Error('expected a refusal');
    } catch (error) {
      const { detail } = error as { detail: any };
      expect(detail.code).toBe('E_WRITE_FORBIDDEN');
      expect(detail.statementType).toBe('multi-statement');
      expect(detail.hint).toMatch(/one statement at a time/);
    }
  });

  it('refuses a data-modifying CTE', () => {
    expect(() =>
      buildPlan(
        'WITH x AS (INSERT INTO film (title) VALUES (1) RETURNING *) SELECT * FROM x',
        { dialect: 'postgres' }
      )
    ).toThrow(/not permitted/);
  });
});
