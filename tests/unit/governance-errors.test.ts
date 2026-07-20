/**
 * T1.2 — structured error taxonomy.
 *
 * PASS criteria: every code in R2.2's union is constructible, each carries a
 * non-empty message, and E_UNKNOWN_COLUMN requires didYouMean.
 */

import { describe, it, expect } from 'vitest';
import {
    ERROR_CODES,
    GovernanceError,
    assertNever,
    isGovernanceError,
    parseError,
    policyDenied,
    resultTooLarge,
    timeout,
    typeMismatch,
    unknownColumn,
    unknownTable,
    unverifiedModel,
    writeForbidden,
    type StructuredError,
} from '../../src/governance/errors.js';

/** One constructed instance per code, used to assert union-wide properties. */
const samples: Record<string, GovernanceError> = {
    E_PARSE: parseError('unexpected token', { line: 1, column: 8 }),
    E_WRITE_FORBIDDEN: writeForbidden('delete'),
    E_UNKNOWN_TABLE: unknownTable('flim', ['film']),
    E_UNKNOWN_COLUMN: unknownColumn('titel', ['title']),
    E_TYPE_MISMATCH: typeMismatch('integer', 'text'),
    E_POLICY_DENIED: policyDenied('rlac:store_scope'),
    E_TIMEOUT: timeout(30_000),
    E_RESULT_TOO_LARGE: resultTooLarge(1_048_576, 2_000_000),
    E_UNVERIFIED_MODEL: unverifiedModel('film'),
};

describe('taxonomy coverage', () => {
    it('constructs one error per declared code', () => {
        expect(Object.keys(samples).sort()).toEqual([...ERROR_CODES].sort());
    });

    it.each(ERROR_CODES)('%s carries a non-empty message', (code) => {
        const err = samples[code];
        expect(err.detail.code).toBe(code);
        expect(err.detail.message.length).toBeGreaterThan(0);
        expect(err.detail.message.trim()).toBe(err.detail.message);
    });

    it.each(ERROR_CODES)('%s is a GovernanceError and an Error', (code) => {
        expect(isGovernanceError(samples[code])).toBe(true);
        expect(samples[code]).toBeInstanceOf(Error);
    });

    it('exposes the code directly', () => {
        expect(samples.E_TIMEOUT.code).toBe('E_TIMEOUT');
    });

    it('sets Error.message from the payload so it survives generic logging', () => {
        expect(samples.E_TIMEOUT.message).toBe(samples.E_TIMEOUT.detail.message);
    });
});

describe('suggestions', () => {
    it('requires didYouMean on E_UNKNOWN_COLUMN', () => {
        // Type-level: omitting didYouMean is a compile error, asserted in
        // tests/types/governance-errors.test-types.ts. This is the runtime half.
        const detail = samples.E_UNKNOWN_COLUMN.detail;
        expect(detail).toHaveProperty('didYouMean');
        expect((detail as Extract<StructuredError, { code: 'E_UNKNOWN_COLUMN' }>).didYouMean)
            .toEqual(['title']);
    });

    it('surfaces suggestions in the hint', () => {
        expect(unknownColumn('titel', ['title', 'titles']).detail.hint)
            .toBe('Did you mean: title, titles?');
    });

    it('omits the hint when there is no suggestion', () => {
        expect(unknownColumn('zzz', []).detail.hint).toBeUndefined();
    });

    it('keeps didYouMean present but empty rather than absent', () => {
        // An absent key and an empty array mean different things to a caller:
        // "no suggestions computed" vs "computed, none matched".
        const detail = unknownColumn('zzz', []).detail;
        expect(detail).toHaveProperty('didYouMean');
    });
});

describe('payload detail', () => {
    it('records the parse location', () => {
        expect(samples.E_PARSE.detail.location).toEqual({ line: 1, column: 8 });
    });

    it('records the forbidden statement type and normalises it for display', () => {
        const detail = writeForbidden('delete').detail as Extract<
            StructuredError,
            { code: 'E_WRITE_FORBIDDEN' }
        >;
        expect(detail.statementType).toBe('delete');
        expect(detail.message).toMatch(/^DELETE is not permitted/);
    });

    it('always hints on a write refusal', () => {
        expect(samples.E_WRITE_FORBIDDEN.detail.hint).toMatch(/SELECT/);
    });

    it('reports both limit and actual size when known', () => {
        expect(samples.E_RESULT_TOO_LARGE.detail.message).toMatch(/1048576-byte cap \(2000000 bytes\)/);
    });

    it('omits actual size when unknown', () => {
        expect(resultTooLarge(100).detail.message).toBe('Result exceeded the 100-byte cap.');
    });

    it('records the timeout that was exceeded', () => {
        const detail = samples.E_TIMEOUT.detail as Extract<StructuredError, { code: 'E_TIMEOUT' }>;
        expect(detail.timeoutMs).toBe(30_000);
    });
});

describe('exhaustiveness', () => {
    // The FAIL criterion for T1.2 is codes that are not exhaustively
    // switchable. This function only compiles while every code is handled.
    function describeCode(detail: StructuredError): string {
        switch (detail.code) {
            case 'E_PARSE': return 'parse';
            case 'E_WRITE_FORBIDDEN': return 'write';
            case 'E_UNKNOWN_TABLE': return 'table';
            case 'E_UNKNOWN_COLUMN': return 'column';
            case 'E_TYPE_MISMATCH': return 'type';
            case 'E_POLICY_DENIED': return 'policy';
            case 'E_TIMEOUT': return 'timeout';
            case 'E_RESULT_TOO_LARGE': return 'size';
            case 'E_UNVERIFIED_MODEL': return 'unverified';
            default: return assertNever(detail, 'error code');
        }
    }

    it.each(ERROR_CODES)('handles %s in an exhaustive switch', (code) => {
        expect(describeCode(samples[code].detail)).toBeTruthy();
    });

    it('throws when handed an unhandled variant at runtime', () => {
        expect(() => assertNever({ code: 'E_FUTURE' } as never, 'error code'))
            .toThrow(/Unhandled error code/);
    });
});

describe('serialization', () => {
    it('round-trips the payload through JSON for the tool boundary', () => {
        for (const code of ERROR_CODES) {
            const parsed = JSON.parse(JSON.stringify(samples[code].detail));
            expect(parsed).toEqual(samples[code].detail);
        }
    });
});
