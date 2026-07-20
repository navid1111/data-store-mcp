/**
 * T1.2 — type-level half of the taxonomy tests.
 *
 * Verified by `npm run typecheck`. An unused `@ts-expect-error` is itself a
 * compile error, so a union that stopped requiring `didYouMean` would fail
 * the build.
 */

import type { StructuredError } from '../../src/governance/errors.js';
import { unknownColumn } from '../../src/governance/errors.js';

// `didYouMean` is required on the codes whose entire purpose is suggesting.
// @ts-expect-error - `didYouMean` is required on E_UNKNOWN_COLUMN
export const columnWithoutSuggestions: StructuredError = {
    code: 'E_UNKNOWN_COLUMN',
    message: 'Unknown column: titel',
};

// @ts-expect-error - `didYouMean` is required on E_UNKNOWN_TABLE
export const tableWithoutSuggestions: StructuredError = {
    code: 'E_UNKNOWN_TABLE',
    message: 'Unknown table: flim',
};

// @ts-expect-error - `statementType` is required on E_WRITE_FORBIDDEN
export const writeWithoutType: StructuredError = {
    code: 'E_WRITE_FORBIDDEN',
    message: 'DELETE is not permitted',
};

// @ts-expect-error - `timeoutMs` is required on E_TIMEOUT
export const timeoutWithoutDuration: StructuredError = {
    code: 'E_TIMEOUT',
    message: 'timed out',
};

// @ts-expect-error - not a member of the union
export const unknownCode: StructuredError = { code: 'E_MADE_UP', message: 'x' };

// Fields belonging to one variant are not available on another.
export const parse: StructuredError = { code: 'E_PARSE', message: 'bad syntax' };
// @ts-expect-error - `didYouMean` does not exist on the E_PARSE variant
export const stray = parse.didYouMean;

// Valid construction still typechecks.
export const valid: StructuredError = {
    code: 'E_UNKNOWN_COLUMN',
    message: 'Unknown column: titel',
    didYouMean: ['title'],
    location: { line: 1, column: 8 },
    hint: 'Did you mean: title?',
};

// Narrowing by `code` exposes the variant's own fields.
export function suggestionsFor(detail: StructuredError): string[] {
    return detail.code === 'E_UNKNOWN_COLUMN' ? detail.didYouMean : [];
}

export const fromFactory = unknownColumn('titel', ['title']).detail;
