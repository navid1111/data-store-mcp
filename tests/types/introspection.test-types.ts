/**
 * T0.4 — type-level tests for the introspection shapes.
 *
 * No runtime assertions: the test is that `tsc` accepts the valid shapes and
 * that every `@ts-expect-error` fires. Verified by `npm run typecheck`.
 */

import type {
    ColumnInfo,
    ColumnProfile,
    ProfileOptions,
    TableInfo,
} from '../../src/sources/types.js';
import { DEFAULT_PROFILE_OPTIONS } from '../../src/sources/types.js';

// Re-exported from database-source for import compatibility.
import type { ColumnInfo as ReExportedColumnInfo } from '../../src/database-source.js';

export const table: TableInfo = { name: 'film', schema: 'public', kind: 'table' };

export const view: TableInfo = {
    name: 'customer_list',
    kind: 'view',
    comment: 'denormalized customer view',
    estimatedRowCount: 599,
};

// @ts-expect-error - `kind` must be 'table' | 'view'
export const badKind: TableInfo = { name: 'film', kind: 'materialized' };

// @ts-expect-error - `name` is required
export const namelessTable: TableInfo = { kind: 'table' };

export const column: ColumnInfo = {
    table: 'film',
    name: 'title',
    dataType: 'character varying',
    nullable: false,
    isPrimaryKey: false,
    isUnique: false,
    position: 2,
};

export const columnWithOptionals: ColumnInfo = {
    ...column,
    defaultValue: "''::character varying",
    comment: 'film title',
};

// `table` is what makes a multi-table getSchema() result attributable (B7).
// @ts-expect-error - `table` is required
export const unattributedColumn: ColumnInfo = {
    name: 'title',
    dataType: 'text',
    nullable: false,
    isPrimaryKey: false,
    isUnique: false,
    position: 1,
};

// Engine-native snake_case keys are not the uniform shape. The directive sits
// on the offending property, not the declaration: an excess-property error is
// reported at the property line.
export const engineShapedColumn: ColumnInfo = {
    ...column,
    // @ts-expect-error - `column_name` is the Postgres-native key, not ColumnInfo's
    column_name: 'title',
};

// @ts-expect-error - `nullable` is a boolean, not the engine's 'YES'/'NO'
export const stringNullable: ColumnInfo = { ...column, nullable: 'NO' };

export const profile: ColumnProfile = {
    table: 'film',
    column: 'rating',
    distinctCount: 5,
    nullRate: 0,
    topValues: [{ value: 'PG-13', count: 223 }],
};

// topValues is optional so it can be omitted for high-cardinality columns
// rather than truncated (T0.7 criterion 3).
export const profileWithoutTopValues: ColumnProfile = {
    table: 'film',
    column: 'film_id',
    distinctCount: 1000,
    nullRate: 0,
};

// @ts-expect-error - `distinctCount` is required
export const incompleteProfile: ColumnProfile = { table: 'film', column: 'x', nullRate: 0 };

export const options: ProfileOptions = { maxDistinctForTopValues: 10 };
export const defaults: Required<ProfileOptions> = DEFAULT_PROFILE_OPTIONS;

// The re-export is the same type, not a structural copy.
export const sameType: ReExportedColumnInfo = column;
