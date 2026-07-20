/**
 * T1.1 — SQL parser.
 *
 * PASS: parses SELECT, CTEs, subqueries, joins and window functions on both
 * dialects; returns E_PARSE with a location for a syntax error.
 * FAIL: parser errors surfaced as raw exceptions; dialect ignored.
 */

import { describe, it, expect } from 'vitest';
import { parseSql, statementType, type Dialect } from '../../src/governance/parse.js';
import { isGovernanceError } from '../../src/governance/errors.js';

const dialects: Dialect[] = ['postgres', 'mysql'];

describe.each(dialects)('parseSql / %s', (dialect) => {
  const parse = (sql: string) => parseSql(sql, dialect);

  describe('accepts', () => {
    it('a simple select', () => {
      const { statements } = parse('SELECT title FROM film');
      expect(statements).toHaveLength(1);
      expect(statementType(statements[0])).toBe('select');
    });

    it('a join', () => {
      const { statements } = parse(`
        SELECT a.first_name, f.title
        FROM actor a
        JOIN film_actor fa ON fa.actor_id = a.actor_id
        JOIN film f ON f.film_id = fa.film_id
      `);
      expect(statementType(statements[0])).toBe('select');
    });

    it('a subquery', () => {
      const { statements } = parse(
        'SELECT title FROM film WHERE film_id IN (SELECT film_id FROM film_actor)'
      );
      expect(statementType(statements[0])).toBe('select');
    });

    it('a common table expression', () => {
      const { statements } = parse(
        'WITH recent AS (SELECT * FROM film) SELECT title FROM recent'
      );
      expect(statementType(statements[0])).toBe('select');
      expect(statements[0].with).toBeTruthy();
    });

    it('a window function', () => {
      const { statements } = parse(
        'SELECT title, row_number() OVER (ORDER BY title) AS rn FROM film'
      );
      expect(statementType(statements[0])).toBe('select');
    });

    it('a union', () => {
      const { statements } = parse('SELECT 1 AS n UNION SELECT 2 AS n');
      expect(statements).toHaveLength(1);
    });

    it('an aggregate with GROUP BY and HAVING', () => {
      const { statements } = parse(
        'SELECT rating, count(*) AS n FROM film GROUP BY rating HAVING count(*) > 1'
      );
      expect(statementType(statements[0])).toBe('select');
    });

    it('SELECT * FROM film', () => {
      // Explicitly required by T1.1: this is the query the row-limit rules
      // in 1.5 have to rewrite.
      expect(statementType(parse('SELECT * FROM film').statements[0])).toBe('select');
    });
  });

  describe('reports statement type', () => {
    it.each([
      ['SELECT 1 AS n', 'select'],
      ['INSERT INTO film (title) VALUES ($$x$$)', 'insert'],
      ['UPDATE film SET title = $$x$$', 'update'],
      ['DELETE FROM film', 'delete'],
    ])('%s -> %s', (sql, expected) => {
      // Postgres dollar-quoting keeps the literal syntax valid on both
      // dialects where a plain quote would not be.
      const usable = dialect === 'mysql' ? sql.replaceAll('$$', "'") : sql;
      expect(statementType(parse(usable).statements[0])).toBe(expected);
    });
  });

  describe('multi-statement input', () => {
    // Deliberately not an error here: "unparseable" and "not allowed" are
    // different facts and the agent must be able to tell them apart. Task 1.3
    // rejects this.
    it('returns every statement rather than throwing', () => {
      const { statements } = parse('SELECT 1 AS a; SELECT 2 AS b');
      expect(statements).toHaveLength(2);
      expect(statements.map(statementType)).toEqual(['select', 'select']);
    });

    it('surfaces a trailing write statement as its own entry', () => {
      const { statements } = parse('SELECT 1 AS a; DELETE FROM film');
      expect(statements.map(statementType)).toEqual(['select', 'delete']);
    });
  });

  describe('rejects', () => {
    it('a syntax error as E_PARSE, not a raw exception', () => {
      try {
        parse('SELECT FROM');
        throw new Error('expected a parse failure');
      } catch (error) {
        expect(isGovernanceError(error)).toBe(true);
        expect((error as any).detail.code).toBe('E_PARSE');
      }
    });

    it('a syntax error with a source location', () => {
      try {
        parse('SELECT * FRM film');
        throw new Error('expected a parse failure');
      } catch (error) {
        const { location } = (error as any).detail;
        expect(location).toBeDefined();
        expect(location.line).toBe(1);
        expect(location.column).toBeGreaterThan(0);
      }
    });

    it('an empty statement', () => {
      expect(() => parse('   ')).toThrow(/empty/);
    });

    it('a non-string input', () => {
      expect(() => parseSql(undefined as never, dialect)).toThrow(/empty/);
    });

    it('carries a hint naming the dialect', () => {
      try {
        parse('SELECT FROM');
      } catch (error) {
        expect((error as any).detail.hint).toContain(dialect);
      }
    });
  });
});

describe('dialect awareness', () => {
  // FAIL criterion: dialect ignored. Asserted with constructs the parser
  // genuinely discriminates — see the caveat on `Dialect`.
  it('accepts ILIKE on postgres and rejects it on mysql', () => {
    const sql = "SELECT 1 AS n FROM film WHERE title ILIKE 'a'";
    expect(() => parseSql(sql, 'postgres')).not.toThrow();
    expect(() => parseSql(sql, 'mysql')).toThrow(/Could not parse SQL/);
  });

  it('accepts ARRAY[...] on postgres and rejects it on mysql', () => {
    expect(() => parseSql('SELECT ARRAY[1,2] AS a', 'postgres')).not.toThrow();
    expect(() => parseSql('SELECT ARRAY[1,2] AS a', 'mysql')).toThrow();
  });

  it('accepts MySQL two-argument LIMIT and rejects it on postgres', () => {
    expect(() => parseSql('SELECT title FROM film LIMIT 1,2', 'mysql')).not.toThrow();
    expect(() => parseSql('SELECT title FROM film LIMIT 1,2', 'postgres')).toThrow();
  });

  it('accepts STRAIGHT_JOIN on mysql and rejects it on postgres', () => {
    const sql = 'SELECT 1 AS n FROM film STRAIGHT_JOIN actor';
    expect(() => parseSql(sql, 'mysql')).not.toThrow();
    expect(() => parseSql(sql, 'postgres')).toThrow();
  });

  // Documented limitation rather than a defect to fix here: the parser is
  // permissive about casts and quoting. Pinning it means we notice if a
  // library upgrade changes the behaviour R2.3 has to compensate for.
  it('does NOT discriminate :: casts or quoting styles', () => {
    for (const dialect of dialects) {
      expect(() => parseSql('SELECT title::text FROM film', dialect)).not.toThrow();
      expect(() => parseSql('SELECT `title` FROM `film`', dialect)).not.toThrow();
      expect(() => parseSql('SELECT "title" FROM "film"', dialect)).not.toThrow();
    }
  });

  it('reports the dialect it parsed with', () => {
    expect(parseSql('SELECT 1 AS n', 'mysql').dialect).toBe('mysql');
    expect(parseSql('SELECT 1 AS n', 'postgres').dialect).toBe('postgres');
  });
});
