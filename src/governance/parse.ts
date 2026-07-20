/**
 * SQL → AST, per dialect (spec.md R2.1).
 *
 * Everything downstream in the gate operates on the AST rather than on text:
 * limit injection, read-only enforcement and RLAC predicate insertion all need
 * structure. A string-matching gate is trivially defeated — `SELECT 'drop
 * table'` is a legitimate read — which is why this module exists at all.
 */

import { Parser } from 'node-sql-parser';
import { parseError, type SourceLocation } from './errors.js';

/**
 * Engines the compiler targets. SQL Server is deferred (spec.md non-goals).
 *
 * Caveat for R2.3: `node-sql-parser`'s dialect enforcement is *partial*. It
 * correctly rejects `ILIKE` and `ARRAY[…]` on MySQL, and `LIMIT n,m` and
 * `STRAIGHT_JOIN` on Postgres — but it accepts `::` casts and both quoting
 * styles everywhere. So parsing under a dialect is a useful filter, not proof
 * that a statement is valid for the target engine. Full R2.3 coverage needs
 * dialect checks in the compiler (task 2.4), not just here.
 */
export type Dialect = 'postgres' | 'mysql';

/** node-sql-parser's own name for each dialect. */
const PARSER_DIALECT: Record<Dialect, string> = {
    postgres: 'postgresql',
    mysql: 'mysql',
};

/**
 * A parsed statement. `node-sql-parser` has no exported AST type worth
 * depending on, so this stays deliberately loose — consumers narrow on `type`.
 */
export interface Statement {
    type?: string;
    [key: string]: unknown;
}

export interface ParseResult {
    /** Every statement in the input, in order. */
    statements: Statement[];
    dialect: Dialect;
}

/** Shape of the PEG parser's syntax error. Not exported by the library. */
interface PegSyntaxError {
    message: string;
    location?: { start?: { line?: number; column?: number } };
}

function toLocation(error: unknown): SourceLocation | undefined {
    const start = (error as PegSyntaxError)?.location?.start;
    if (typeof start?.line === 'number' && typeof start?.column === 'number') {
        return { line: start.line, column: start.column };
    }
    return undefined;
}

/**
 * Parses SQL into one or more statements.
 *
 * Multi-statement input is *not* an error here — the parser returns an array
 * and the caller decides. Read-only enforcement rejects it (task 1.3); doing
 * so at parse time would conflate "unparseable" with "not allowed", and the
 * agent needs to tell those apart.
 *
 * @throws GovernanceError with code E_PARSE
 */
export function parseSql(sql: string, dialect: Dialect): ParseResult {
    if (typeof sql !== 'string' || sql.trim().length === 0) {
        throw parseError('statement is empty', undefined, 'Provide a SELECT statement.');
    }

    const parser = new Parser();
    let ast: unknown;

    try {
        ast = parser.astify(sql, { database: PARSER_DIALECT[dialect] });
    } catch (error) {
        throw parseError(
            (error as PegSyntaxError)?.message ?? String(error),
            toLocation(error),
            `Check the statement against ${dialect} syntax.`,
        );
    }

    const statements = (Array.isArray(ast) ? ast : [ast]) as Statement[];

    if (statements.length === 0) {
        throw parseError('no statement found');
    }

    return { statements, dialect };
}

/**
 * Lowercased statement type, e.g. `select`, `delete`, `update`.
 * Returns `unknown` rather than throwing so callers can report it.
 */
export function statementType(statement: Statement): string {
    return typeof statement.type === 'string' ? statement.type.toLowerCase() : 'unknown';
}
