/**
 * Structured error taxonomy for the governance gate (spec.md R2.2).
 *
 * Errors are data, not prose. A raw driver string ("relation does not exist")
 * tells an agent something failed but not what to do next; a structured error
 * carries a machine-readable code, a source location, a hint, and — for the
 * case that matters most — the columns the agent probably meant.
 *
 * Two properties are enforced by the type system rather than by convention:
 *  - The payload is a discriminated union, so a `switch` over `code` that
 *    misses a case is a compile error (see {@link assertNever}).
 *  - `E_UNKNOWN_COLUMN` and `E_UNKNOWN_TABLE` *require* `didYouMean`. The
 *    suggestion is the whole point of those codes, so it cannot be forgotten.
 */

export interface SourceLocation {
    line: number;
    column: number;
}

interface ErrorBase {
    message: string;
    /** Where in the submitted SQL the problem is, when known. */
    location?: SourceLocation;
    /** What the agent should do differently. */
    hint?: string;
}

export type StructuredError =
    | (ErrorBase & { code: 'E_PARSE' })
    | (ErrorBase & { code: 'E_WRITE_FORBIDDEN'; statementType: string })
    | (ErrorBase & { code: 'E_UNKNOWN_TABLE'; didYouMean: string[] })
    | (ErrorBase & { code: 'E_UNKNOWN_COLUMN'; didYouMean: string[] })
    | (ErrorBase & { code: 'E_TYPE_MISMATCH'; expected: string; actual: string })
    | (ErrorBase & { code: 'E_POLICY_DENIED'; policy: string })
    | (ErrorBase & { code: 'E_TIMEOUT'; timeoutMs: number })
    | (ErrorBase & { code: 'E_RESULT_TOO_LARGE'; limit: number; actual?: number })
    | (ErrorBase & { code: 'E_UNVERIFIED_MODEL'; model: string });

export type ErrorCode = StructuredError['code'];

/** Every code, for exhaustiveness tests and tooling. */
export const ERROR_CODES = [
    'E_PARSE',
    'E_WRITE_FORBIDDEN',
    'E_UNKNOWN_TABLE',
    'E_UNKNOWN_COLUMN',
    'E_TYPE_MISMATCH',
    'E_POLICY_DENIED',
    'E_TIMEOUT',
    'E_RESULT_TOO_LARGE',
    'E_UNVERIFIED_MODEL',
] as const satisfies readonly ErrorCode[];

/**
 * An error carrying a {@link StructuredError} payload.
 *
 * Extends Error so it propagates through normal control flow, but callers
 * should read `.detail` rather than `.message` — the payload is the contract.
 */
export class GovernanceError extends Error {
    readonly detail: StructuredError;

    constructor(detail: StructuredError) {
        super(detail.message);
        this.name = 'GovernanceError';
        this.detail = detail;
    }

    get code(): ErrorCode {
        return this.detail.code;
    }
}

export function isGovernanceError(error: unknown): error is GovernanceError {
    return error instanceof GovernanceError;
}

/**
 * Compile-time exhaustiveness guard. A `switch` over `StructuredError['code']`
 * that gains a new member without handling it fails to typecheck here.
 */
export function assertNever(value: never, context = 'value'): never {
    throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------- factories
//
// Constructing errors through factories rather than object literals keeps the
// messages consistent and guarantees every payload carries a non-empty one.

export function parseError(
    message: string,
    location?: SourceLocation,
    hint?: string,
): GovernanceError {
    return new GovernanceError({
        code: 'E_PARSE',
        message: `Could not parse SQL: ${message}`,
        ...(location ? { location } : {}),
        ...(hint ? { hint } : {}),
    });
}

export function writeForbidden(statementType: string, hint?: string): GovernanceError {
    return new GovernanceError({
        code: 'E_WRITE_FORBIDDEN',
        statementType,
        message: `${statementType.toUpperCase()} is not permitted; this connection is read-only.`,
        hint: hint ?? 'Only SELECT statements and read-only CTEs are allowed.',
    });
}

export function unknownTable(name: string, didYouMean: string[]): GovernanceError {
    return new GovernanceError({
        code: 'E_UNKNOWN_TABLE',
        didYouMean,
        message: `Unknown table: ${name}`,
        ...(didYouMean.length ? { hint: `Did you mean: ${didYouMean.join(', ')}?` } : {}),
    });
}

export function unknownColumn(
    name: string,
    didYouMean: string[],
    location?: SourceLocation,
): GovernanceError {
    return new GovernanceError({
        code: 'E_UNKNOWN_COLUMN',
        didYouMean,
        message: `Unknown column: ${name}`,
        ...(location ? { location } : {}),
        ...(didYouMean.length ? { hint: `Did you mean: ${didYouMean.join(', ')}?` } : {}),
    });
}

export function typeMismatch(expected: string, actual: string, hint?: string): GovernanceError {
    return new GovernanceError({
        code: 'E_TYPE_MISMATCH',
        expected,
        actual,
        message: `Type mismatch: expected ${expected}, got ${actual}`,
        ...(hint ? { hint } : {}),
    });
}

export function policyDenied(policy: string, message?: string): GovernanceError {
    return new GovernanceError({
        code: 'E_POLICY_DENIED',
        policy,
        message: message ?? `Denied by policy: ${policy}`,
    });
}

export function timeout(timeoutMs: number): GovernanceError {
    return new GovernanceError({
        code: 'E_TIMEOUT',
        timeoutMs,
        message: `Query exceeded the ${timeoutMs}ms timeout and was cancelled.`,
        hint: 'Narrow the query with a WHERE clause or a smaller LIMIT.',
    });
}

export function resultTooLarge(limit: number, actual?: number): GovernanceError {
    return new GovernanceError({
        code: 'E_RESULT_TOO_LARGE',
        limit,
        ...(actual !== undefined ? { actual } : {}),
        message:
            `Result exceeded the ${limit}-byte cap` +
            (actual !== undefined ? ` (${actual} bytes)` : '') +
            '.',
        hint: 'Select fewer columns or add a smaller LIMIT.',
    });
}

export function unverifiedModel(model: string): GovernanceError {
    return new GovernanceError({
        code: 'E_UNVERIFIED_MODEL',
        model,
        message: `Model "${model}" has not been verified by a human reviewer.`,
        hint: 'Its description may be machine-generated and inaccurate.',
    });
}
