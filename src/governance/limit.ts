/**
 * Row-limit enforcement (spec.md R1.1).
 *
 * The limit is set on the AST and the SQL is regenerated from it. Appending
 * ` LIMIT n` to the text would break on a trailing comment or semicolon, and
 * would silently produce two LIMIT clauses on a query that already had one.
 *
 * Finding the existing limit is fiddlier than it looks — the operand order
 * depends on the separator, and one form has no limit at all:
 *
 *   LIMIT 10            seperator ''        value [10]           limit at 0
 *   LIMIT 1,2           seperator ','       value [1, 2]         limit at 1  (MySQL: offset first)
 *   LIMIT 10 OFFSET 5   seperator 'offset'  value [10, 5]        limit at 0
 *   OFFSET 5            seperator 'offset'  value [5]            no limit
 *
 * Reading index 0 unconditionally would clamp the *offset* of a
 * `LIMIT 1,2` query and mistake a bare `OFFSET 5` for a limit of 5.
 */

import type { Statement } from './parse.js';

export interface LimitOptions {
    /** Applied when the query has none. */
    defaultLimit?: number;
    /** Ceiling the caller cannot exceed. */
    maxLimit?: number;
}

export const DEFAULT_LIMITS: Required<LimitOptions> = {
    defaultLimit: 1000,
    maxLimit: 10_000,
};

interface LimitNode {
    seperator?: string;
    value?: Array<{ type?: string; value?: unknown }>;
}

/**
 * Index of the limit operand within `limit.value`, or null when the clause
 * carries only an offset.
 */
function limitIndex(limit: LimitNode): number | null {
    const values = limit.value ?? [];
    if (values.length === 0) return null;

    switch (limit.seperator) {
        // MySQL `LIMIT offset, count`
        case ',':
            return values.length >= 2 ? 1 : 0;
        // `LIMIT n OFFSET m` has both; a bare `OFFSET m` has only the offset.
        case 'offset':
            return values.length >= 2 ? 0 : null;
        default:
            return 0;
    }
}

/**
 * The statement whose LIMIT governs the whole result.
 *
 * For a UNION the parser chains arms through `_next` and attaches the
 * statement-level LIMIT to the *last* arm, because that is where SQL puts it:
 * `SELECT a FROM t1 UNION SELECT a FROM t2 LIMIT 5` limits the union, not the
 * second arm. Limiting each arm separately would change the result set, which
 * is why this walks to the tail rather than rewriting every arm.
 */
function governingStatement(statement: Statement): Statement {
    let current = statement;
    while (current._next && typeof current._next === 'object') {
        current = current._next as Statement;
    }
    return current;
}

/**
 * Ensures the statement carries a row limit no greater than `maxLimit`,
 * mutating the AST in place.
 *
 * @returns the limit now in force
 */
export function applyRowLimit(statement: Statement, options?: LimitOptions): number {
    const { defaultLimit, maxLimit } = { ...DEFAULT_LIMITS, ...options };
    const target = governingStatement(statement);
    const existing = target.limit as LimitNode | null | undefined;

    const index = existing ? limitIndex(existing) : null;

    if (existing && index !== null) {
        const current = Number(existing.value![index].value);
        // The smaller of the two wins: a caller asking for fewer rows than the
        // default gets what they asked for; one asking for more is clamped.
        const effective = Number.isFinite(current)
            ? Math.min(current, maxLimit)
            : Math.min(defaultLimit, maxLimit);

        existing.value![index] = { type: 'number', value: effective };
        return effective;
    }

    const effective = Math.min(defaultLimit, maxLimit);

    if (existing && existing.seperator === 'offset' && (existing.value?.length ?? 0) === 1) {
        // Bare OFFSET: promote to `LIMIT n OFFSET m`, preserving the offset.
        const offset = existing.value![0];
        existing.value = [{ type: 'number', value: effective }, offset];
        return effective;
    }

    target.limit = { seperator: '', value: [{ type: 'number', value: effective }] };
    return effective;
}
