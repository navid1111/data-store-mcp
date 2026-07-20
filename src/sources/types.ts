/**
 * Introspection types shared by every adapter.
 *
 * These are the uniform shapes that task 0.5 makes all three adapters return.
 * Today each adapter returns whatever its engine happens to produce —
 * `column_name`/`data_type` on Postgres, `Field`/`Type` on MySQL — which is
 * spec.md B9/B13 and blocks `mdl bootstrap` (spec.md §5.1).
 *
 * Field names are lowerCamelCase and engine-neutral on purpose: a bootstrap
 * pipeline must not need to know which engine produced a row.
 */

/** What kind of relation a {@link TableInfo} describes. */
export type TableKind = 'table' | 'view';

/** One table, view, or collection. Returned by `listTables()`. */
export interface TableInfo {
    /** Table name, unqualified. */
    name: string;
    /** Schema/database qualifier: `public` on Postgres, the database on MySQL. */
    schema?: string;
    kind: TableKind;
    /** Database-level comment, where the engine records one (spec.md §5.1). */
    comment?: string;
    /**
     * Approximate row count from engine statistics, not `count(*)`.
     * Absent when the engine has no estimate (e.g. never analyzed).
     */
    estimatedRowCount?: number;
}

/** One column. Returned by `getSchema()`. */
export interface ColumnInfo {
    /**
     * Owning table. Present on every column so a multi-table `getSchema()`
     * result can be attributed — this field is the fix for spec.md B7.
     */
    table: string;
    name: string;
    /** Engine-native type name, e.g. `character varying`, `int`. */
    dataType: string;
    nullable: boolean;
    /** True for every column of a composite primary key, not just the first. */
    isPrimaryKey: boolean;
    /** Covered by a single-column unique constraint or unique index. */
    isUnique: boolean;
    /** Column default as the engine reports it; absent when there is none. */
    defaultValue?: string;
    /** Database-level column comment; absent when there is none. */
    comment?: string;
    /** 1-based position in the table, for stable ordering. */
    position: number;
}

/** One sampled value and how often it occurred. */
export interface ProfileValue {
    value: unknown;
    count: number;
}

/**
 * Statistical profile of a column. Returned by `profile()` (task 0.7).
 *
 * `topValues` is deliberately optional: it is omitted for high-cardinality
 * columns rather than truncated, so profiling a primary key cannot flood the
 * agent's context (test.md T0.7 criterion 3).
 */
export interface ColumnProfile {
    table: string;
    column: string;
    /** Distinct non-null values, computed in-engine via `count(distinct …)`. */
    distinctCount: number;
    /** Fraction of rows that are null, 0–1. */
    nullRate: number;
    /** Present for ordered types (numeric, temporal); absent for text. */
    min?: unknown;
    max?: unknown;
    /** Present only when `distinctCount` is at or below the configured cutoff. */
    topValues?: ProfileValue[];
}

/** Options accepted by `profile()`. */
export interface ProfileOptions {
    /** Above this many distinct values, `topValues` is omitted. Default 50. */
    maxDistinctForTopValues?: number;
    /** How many top values to return when they are included. Default 20. */
    topValueLimit?: number;
}

export const DEFAULT_PROFILE_OPTIONS: Required<ProfileOptions> = {
    maxDistinctForTopValues: 50,
    topValueLimit: 20,
};
