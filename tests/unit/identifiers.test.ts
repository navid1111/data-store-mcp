/**
 * T0.3 criterion 4 — identifier validator.
 *
 * Pure logic, no I/O. The integration suites cover criteria 1–3 (behaviour
 * against a live database).
 */

import { describe, it, expect } from 'vitest';
import {
  assertValidIdentifier,
  quoteMysqlIdentifier,
  quotePostgresIdentifier,
  InvalidIdentifierError,
} from '../../src/identifiers.js';

describe('assertValidIdentifier', () => {
  describe('accepts', () => {
    it.each(['film', 'film_actor', 'FilmActor', '_private', 'a', 'a1', 'staff_list'])(
      '%s',
      (name) => {
        expect(assertValidIdentifier(name)).toBe(name);
      }
    );

    it('accepts an identifier at the 63-character limit', () => {
      const name = 'a'.repeat(63);
      expect(assertValidIdentifier(name)).toBe(name);
    });
  });

  describe('rejects', () => {
    const cases: Array<[string, string]> = [
      ['empty string', ''],
      ['backtick', 'film`'],
      ['single quote', "film'"],
      ['double quote', 'film"'],
      ['semicolon', 'film;'],
      ['line comment', 'film--'],
      ['block comment', 'film/*'],
      ['space', 'film actor'],
      ['leading digit', '2024_sales'],
      ['dot-qualified', 'public.film'],
      ['parenthesis', 'film()'],
      ['backslash', 'film\\'],
      ['null byte', 'film\0'],
      ['newline', 'film\n'],
      ['classic injection', "film' OR '1'='1"],
      ['stacked statement', 'film; SELECT 1'],
      ['over length', 'a'.repeat(64)],
    ];

    it.each(cases)('%s', (_label, value) => {
      expect(() => assertValidIdentifier(value)).toThrow(InvalidIdentifierError);
    });

    it.each([undefined, null, 42, {}, []])('non-string: %s', (value) => {
      expect(() => assertValidIdentifier(value)).toThrow(InvalidIdentifierError);
    });
  });

  it('names the kind in the error message', () => {
    expect(() => assertValidIdentifier('bad;', 'table name')).toThrow(/Invalid table name/);
  });

  it('includes the offending value in the error message', () => {
    expect(() => assertValidIdentifier('bad;')).toThrow(/"bad;"/);
  });
});

describe('quoteMysqlIdentifier', () => {
  it('backtick-quotes a valid identifier', () => {
    expect(quoteMysqlIdentifier('film')).toBe('`film`');
  });

  it('rejects rather than escaping an invalid identifier', () => {
    // Escaping would produce a syntactically valid query against an unintended
    // object; rejection is the required behaviour.
    expect(() => quoteMysqlIdentifier('film`; DROP TABLE film; --')).toThrow(
      InvalidIdentifierError
    );
  });
});

describe('quotePostgresIdentifier', () => {
  it('double-quotes a valid identifier', () => {
    expect(quotePostgresIdentifier('film')).toBe('"film"');
  });

  it('rejects an invalid identifier', () => {
    expect(() => quotePostgresIdentifier('film"')).toThrow(InvalidIdentifierError);
  });
});
