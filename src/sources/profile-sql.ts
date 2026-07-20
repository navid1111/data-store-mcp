/**
 * Shared column profiling for SQL engines.
 *
 * Postgres and MySQL differ only in identifier quoting, so both adapters call
 * this rather than each growing its own copy — the same reasoning that drove
 * the uniform introspection shapes in task 0.5.
 *
 * Two properties matter and are asserted by test.md T0.7:
 *  - Cardinality is computed in-engine with `count(distinct …)`. Materializing
 *    `SELECT DISTINCT` in Node would pull the whole column across the wire.
 *  - `topValues` is *omitted* above the cardinality cutoff rather than
 *    truncated, so profiling a primary key cannot flood the agent's context.
 */

import type {
    ColumnInfo,
    ColumnProfile,
    ProfileOptions,
    ProfileValue,
} from './types.js';
import type { Row } from '../database-source.js';
import { DEFAULT_PROFILE_OPTIONS } from './types.js';

/**
 * Types with a meaningful min/max. Text, boolean, binary, arrays and
 * engine-specific types (tsvector, enums) are excluded: a min/max over them is
 * either meaningless to an agent or unsupported by the engine.
 */
const ORDERED_TYPE = /^(tiny|small|medium|big)?int|^numeric|^decimal|^real|^double|^float|^money|^date|^time|^timestamp|^year|^serial/i;

export function isOrderedType(dataType: string): boolean {
    return ORDERED_TYPE.test(dataType.trim());
}

export interface SqlProfileContext {
    /** Engine-specific identifier quoting, already validating. */
    quote: (identifier: string, kind?: string) => string;
    query: (sql: string) => Promise<Row[]>;
    table: string;
    /** Columns to profile, as returned by `getSchema(table)`. */
    columns: ColumnInfo[];
    options?: ProfileOptions;
}

export async function profileSqlColumns(ctx: SqlProfileContext): Promise<ColumnProfile[]> {
    const { quote, query, table, columns } = ctx;
    const options = { ...DEFAULT_PROFILE_OPTIONS, ...ctx.options };

    if (columns.length === 0) {
        return [];
    }

    const quotedTable = quote(table, 'table name');

    // One pass over the table for every column's aggregates, rather than one
    // query per column. Aliases are positional so they are always safe
    // identifiers regardless of the column's real name.
    const selectList = columns.flatMap((column, i) => {
        const c = quote(column.name, 'column name');
        const parts = [
            `count(${c}) AS c${i}_nonnull`,
            `count(DISTINCT ${c}) AS c${i}_distinct`,
        ];
        if (isOrderedType(column.dataType)) {
            parts.push(`min(${c}) AS c${i}_min`, `max(${c}) AS c${i}_max`);
        }
        return parts;
    });

    const [stats] = await query(
        `SELECT count(*) AS total, ${selectList.join(', ')} FROM ${quotedTable}`
    );

    const total = Number(stats.total ?? 0);

    const profiles: ColumnProfile[] = columns.map((column, i) => {
        const nonNull = Number(stats[`c${i}_nonnull`] ?? 0);
        const distinctCount = Number(stats[`c${i}_distinct`] ?? 0);

        const profile: ColumnProfile = {
            table,
            column: column.name,
            distinctCount,
            nullRate: total === 0 ? 0 : (total - nonNull) / total,
        };

        if (isOrderedType(column.dataType)) {
            const min = stats[`c${i}_min`];
            const max = stats[`c${i}_max`];
            if (min != null) profile.min = min;
            if (max != null) profile.max = max;
        }

        return profile;
    });

    // Top values only for columns at or below the cutoff. Fetched per column
    // because each needs its own GROUP BY.
    await Promise.all(
        profiles.map(async (profile, i) => {
            if (
                profile.distinctCount === 0 ||
                profile.distinctCount > options.maxDistinctForTopValues
            ) {
                return;
            }

            const c = quote(columns[i].name, 'column name');
            const rows = await query(`
                SELECT ${c} AS value, count(*) AS frequency
                FROM ${quotedTable}
                WHERE ${c} IS NOT NULL
                GROUP BY ${c}
                ORDER BY count(*) DESC, ${c}
                LIMIT ${options.topValueLimit}
            `);

            profile.topValues = rows.map(
                (r): ProfileValue => ({ value: r.value, count: Number(r.frequency) })
            );
        })
    );

    return profiles;
}
