/**
 * The governance gate (architecture.md §2.5, §4.1).
 *
 * One entry point: caller-supplied SQL in, an approved {@link QueryPlan} out.
 * Refusals throw a {@link GovernanceError} carrying a structured payload the
 * agent can act on.
 *
 * The order matters. Read-only is asserted before rewriting, so a rejected
 * statement is never modified and the error names what the caller actually
 * submitted rather than something the gate produced.
 */

// node-sql-parser is CommonJS. A named import works under Vitest's transform
// but throws "Named export 'Parser' not found" in real Node ESM, which crashes
// the built server on startup — caught only by the e2e suite.
import sqlParser from 'node-sql-parser';
const { Parser } = sqlParser;
import { parseSql, type Dialect } from './parse.js';
import { assertReadOnly } from './read-only.js';
import { applyRowLimit, type LimitOptions } from './limit.js';
import { createQueryPlan, type QueryPlan } from './plan.js';
import { parseError } from './errors.js';

const PARSER_DIALECT: Record<Dialect, string> = {
    postgres: 'postgresql',
    mysql: 'mysql',
};

export interface GateOptions extends LimitOptions {
    dialect: Dialect;
    /** Bound parameters supplied by the caller; carried onto the plan. */
    params?: readonly unknown[];
}

/**
 * Validates and rewrites SQL into an executable plan.
 *
 * @throws GovernanceError — E_PARSE, E_WRITE_FORBIDDEN
 */
export function buildPlan(sql: string, options: GateOptions): QueryPlan {
    const parsed = parseSql(sql, options.dialect);

    // Before any rewriting: a refused statement must be reported as submitted.
    assertReadOnly(parsed);

    const [statement] = parsed.statements;
    const appliedLimit = applyRowLimit(statement, options);

    const parser = new Parser();
    let rewritten: string;
    try {
        rewritten = parser.sqlify(statement as never, {
            database: PARSER_DIALECT[options.dialect],
        });
    } catch (error) {
        // Regeneration failing is a bug here, not bad input, but it must not
        // fall through to an ungoverned path.
        throw parseError(
            `could not regenerate SQL after applying governance: ${(error as Error).message}`,
        );
    }

    return createQueryPlan({
        sql: rewritten,
        params: options.params,
        dialect: options.dialect,
        appliedLimit,
        appliedPolicies: [`limit:${appliedLimit}`, 'read-only'],
    });
}

/** Maps a source type onto the dialect its SQL should be parsed as. */
export function dialectFor(sourceType: string): Dialect {
    switch (sourceType) {
        case 'postgres':
            return 'postgres';
        case 'mysql':
            return 'mysql';
        default:
            throw parseError(`No SQL dialect is configured for source type "${sourceType}".`);
    }
}
