/**
 * T1.3 — read-only enforcement.
 *
 * The FAIL criteria drive the shape of this suite: a keyword blocklist must
 * not be the implementation (so `SELECT 'drop table'` has to be *allowed*),
 * and the data-modifying-CTE case must not be skipped.
 */

import { describe, it, expect } from 'vitest';
import { parseSql, type Dialect } from '../../src/governance/parse.js';
import { assertReadOnly } from '../../src/governance/read-only.js';
import { isGovernanceError } from '../../src/governance/errors.js';

const dialects: Dialect[] = ['postgres', 'mysql'];

function check(sql: string, dialect: Dialect = 'postgres') {
  assertReadOnly(parseSql(sql, dialect));
}

/** Asserts refusal with E_WRITE_FORBIDDEN specifically, not merely a throw. */
function expectRefused(sql: string, dialect: Dialect = 'postgres') {
  try {
    check(sql, dialect);
  } catch (error) {
    expect(isGovernanceError(error)).toBe(true);
    expect((error as any).detail.code).toBe('E_WRITE_FORBIDDEN');
    return (error as any).detail;
  }
  throw new Error(`expected ${sql} to be refused`);
}

describe.each(dialects)('assertReadOnly / %s', (dialect) => {
  describe('allows reads', () => {
    it.each([
      ['a simple select', 'SELECT title FROM film'],
      ['a join', 'SELECT 1 AS n FROM film f JOIN film_actor fa ON fa.film_id = f.film_id'],
      ['a subquery', 'SELECT 1 AS n FROM film WHERE film_id IN (SELECT film_id FROM film_actor)'],
      ['a union', 'SELECT 1 AS n UNION SELECT 2 AS n'],
      ['a read-only CTE', 'WITH x AS (SELECT 1 AS n) SELECT * FROM x'],
      ['nested read-only CTEs', 'WITH a AS (SELECT 1 AS n), b AS (SELECT * FROM a) SELECT * FROM b'],
      ['an aggregate', 'SELECT rating, count(*) AS n FROM film GROUP BY rating'],
      ['a window function', 'SELECT row_number() OVER (ORDER BY title) AS rn FROM film'],
    ])('%s', (_label, sql) => {
      expect(() => check(sql, dialect)).not.toThrow();
    });

    // The FAIL criterion for T1.3: a keyword blocklist would reject these.
    it('a string literal containing a write keyword', () => {
      expect(() => check("SELECT 'drop table' AS s", dialect)).not.toThrow();
    });

    it('a column alias containing a write keyword', () => {
      expect(() => check('SELECT title AS delete_me FROM film', dialect)).not.toThrow();
    });

    it('a table whose name contains a write keyword', () => {
      expect(() => check('SELECT 1 AS n FROM update_log', dialect)).not.toThrow();
    });
  });

  describe('refuses writes', () => {
    const literal = dialect === 'mysql' ? "'x'" : "'x'";

    it.each([
      ['insert', `INSERT INTO film (title) VALUES (${literal})`],
      ['update', `UPDATE film SET title = ${literal}`],
      ['delete', 'DELETE FROM film'],
      ['drop', 'DROP TABLE film'],
      ['truncate', 'TRUNCATE TABLE film'],
      ['create', 'CREATE TABLE t (id int)'],
      ['rename', 'RENAME TABLE film TO film2'],
    ])('%s', (_label, sql) => {
      // Some DDL is rejected by the parser rather than the gate; either way
      // it must not execute. Assert refusal, not which layer refused.
      expect(() => check(sql, dialect)).toThrow();
    });

    it('reports the statement type it refused', () => {
      expect(expectRefused('DELETE FROM film', dialect).statementType).toBe('delete');
    });

    it('always hints at what is allowed', () => {
      expect(expectRefused('DELETE FROM film', dialect).hint).toMatch(/SELECT/i);
    });
  });

  describe('refuses multi-statement input', () => {
    it('a select followed by a delete', () => {
      const detail = expectRefused('SELECT 1 AS n; DELETE FROM film', dialect);
      expect(detail.statementType).toBe('multi-statement');
    });

    // The first statement is a harmless select, so checking only
    // statements[0] would let this through.
    it('two selects', () => {
      expect(() => check('SELECT 1 AS a; SELECT 2 AS b', dialect)).toThrow();
    });

    it('names the statements it received', () => {
      const detail = expectRefused('SELECT 1 AS n; DELETE FROM film', dialect);
      expect(detail.hint).toMatch(/select, delete/);
    });
  });
});

describe('bypass routes that parse as SELECT', () => {
  // Each of these has `type: 'select'` at the root. A naive root-type check
  // passes all three — which is precisely why they are tested individually.

  it('refuses a data-modifying CTE containing INSERT', () => {
    const detail = expectRefused(
      'WITH x AS (INSERT INTO film (title) VALUES (1) RETURNING *) SELECT * FROM x'
    );
    expect(detail.statementType).toBe('insert');
    expect(detail.hint).toMatch(/CTE containing INSERT/i);
  });

  it('refuses a data-modifying CTE containing UPDATE', () => {
    const detail = expectRefused(
      'WITH x AS (UPDATE film SET title = 1 RETURNING *) SELECT * FROM x'
    );
    expect(detail.statementType).toBe('update');
  });

  it('refuses a write nested in a second CTE', () => {
    expectRefused(
      'WITH a AS (SELECT 1 AS n), b AS (UPDATE film SET title = 1 RETURNING *) SELECT * FROM b'
    );
  });

  it('refuses SELECT ... INTO, which creates a table', () => {
    const detail = expectRefused('SELECT * INTO new_table FROM film');
    expect(detail.statementType).toBe('select-into');
    expect(detail.hint).toMatch(/INTO/);
  });

  it('confirms the root really is a select for each bypass', () => {
    // Guards the premise of this whole block: if the parser starts reporting
    // these as writes, these tests would pass for the wrong reason.
    for (const sql of [
      'WITH x AS (INSERT INTO film (title) VALUES (1) RETURNING *) SELECT * FROM x',
      'SELECT * INTO new_table FROM film',
    ]) {
      expect(parseSql(sql, 'postgres').statements[0].type).toBe('select');
    }
  });
});
