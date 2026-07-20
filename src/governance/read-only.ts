/**
 * Read-only enforcement (spec.md R1.2).
 *
 * Checks the parsed AST, never the SQL text. A keyword blocklist is both
 * unsound and over-strict: it rejects `SELECT 'drop table'` (a legitimate
 * read) while missing anything that reaches a write by another route.
 *
 * Three such routes exist and all three parse with `type: 'select'`, so a
 * naive "the root node is a SELECT" check passes them:
 *
 *   1. `WITH x AS (INSERT INTO t … RETURNING *) SELECT * FROM x`
 *      A data-modifying CTE. The root is a select; the write hides in `with`.
 *   2. `SELECT * INTO new_table FROM film`
 *      Creates and populates a table. The root is a select; the write is the
 *      `into` clause.
 *   3. `SELECT 1; DELETE FROM film`
 *      Multi-statement input. The first statement is a select and the parser
 *      returns an array, so checking only `statements[0]` misses the rest.
 */

import { writeForbidden } from './errors.js';
import { statementType, type ParseResult, type Statement } from './parse.js';

/** Statement types that read and nothing else. */
const READ_ONLY_TYPES = new Set(['select']);

interface WithClauseEntry {
    stmt?: Statement;
}

/**
 * The two dialects disagree on how a CTE body is nested: Postgres puts the
 * statement directly on `stmt`, MySQL wraps it as `stmt.ast` alongside
 * `tableList`/`columnList`. Without unwrapping, a MySQL CTE reads as type
 * `unknown` — which fails safe, but refuses every legitimate CTE.
 */
function cteBody(entry: WithClauseEntry): Statement | undefined {
    const stmt = entry?.stmt;
    if (!stmt) return undefined;

    const wrapped = (stmt as { ast?: Statement }).ast;
    return wrapped ?? stmt;
}

interface SelectInto {
    /** Target relation name; null/undefined on a plain select. */
    expr?: unknown;
}

/**
 * Throws unless every statement in `parsed` is purely read-only.
 *
 * @throws GovernanceError with code E_WRITE_FORBIDDEN
 */
export function assertReadOnly(parsed: ParseResult): void {
    if (parsed.statements.length > 1) {
        const types = parsed.statements.map(statementType);
        throw writeForbidden(
            'multi-statement',
            `Submit one statement at a time; received ${types.length} (${types.join(', ')}).`,
        );
    }

    for (const statement of parsed.statements) {
        assertStatementReadOnly(statement);
    }
}

function assertStatementReadOnly(statement: Statement): void {
    const type = statementType(statement);

    if (!READ_ONLY_TYPES.has(type)) {
        throw writeForbidden(type);
    }

    // Route 2: SELECT ... INTO new_table
    const into = statement.into as SelectInto | undefined;
    if (into?.expr != null) {
        throw writeForbidden(
            'select-into',
            'SELECT ... INTO creates a table. Remove the INTO clause.',
        );
    }

    // Route 1: a data-modifying CTE. Recurse — CTEs can nest.
    const withClause = statement.with;
    if (Array.isArray(withClause)) {
        for (const entry of withClause as WithClauseEntry[]) {
            const body = cteBody(entry);
            if (body) {
                assertCteReadOnly(body);
            }
        }
    }
}

function assertCteReadOnly(statement: Statement): void {
    const type = statementType(statement);

    if (!READ_ONLY_TYPES.has(type)) {
        throw writeForbidden(
            type,
            `A CTE containing ${type.toUpperCase()} modifies data even when the outer statement is a SELECT.`,
        );
    }

    assertStatementReadOnly(statement);
}
