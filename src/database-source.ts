// Introspection shapes live in sources/types.ts; re-exported so existing
// imports from database-source.js keep working while the layout migrates
// toward architecture.md §3.
export type {
    TableKind,
    TableInfo,
    ColumnInfo,
    ProfileValue,
    ColumnProfile,
    ProfileOptions,
} from "./sources/types.js";
export { DEFAULT_PROFILE_OPTIONS } from "./sources/types.js";
import type { TableInfo, ColumnInfo, ColumnProfile, ProfileOptions } from "./sources/types.js";
import type { ExecuteOptions, QueryPlan } from "./governance/plan.js";
import type { MongoQueryPlan } from "./governance/mongo.js";

/** Every branded plan accepted by the common Database boundary. */
export type ExecutionPlan = QueryPlan | MongoQueryPlan;

export type DatabaseType = "mysql" | "postgres" | "sqlserver" | "mongodb";

/**
 * A result row. Values are `unknown` rather than `any` so callers narrow
 * deliberately. Task 0.5 replaces ad-hoc row shapes with `ColumnInfo`.
 */
export type Row = Record<string, unknown>;

/** Bound query parameters: positional for SQL, named for MSSQL and Mongo payloads. */
export type QueryParams = unknown[] | Record<string, unknown>;

/** Host/port credentials, shared by every SQL engine. */
export interface SqlConnectionOptions {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
}

export interface MssqlConnectionOptions extends SqlConnectionOptions {
    encrypt?: boolean;
    trustServerCertificate?: boolean;
    /**
     * @deprecated PascalCase spelling the existing adapter also accepts.
     * Retained so typing this union does not silently change the behaviour of
     * deferred SQL Server code. Remove when SQL Server is un-deferred.
     */
    TrustServerCertificate?: boolean;
}

/** MongoDB connects by URI, not host/port — hence the separate shape. */
export interface MongoConnectionOptions {
    uri: string;
    database: string;
}

interface ConnectionConfigBase<T extends DatabaseType, O> {
    id: string;
    type: T;
    description?: string;
    options: O;
}

export type PostgresConnectionConfig = ConnectionConfigBase<'postgres', SqlConnectionOptions>;
export type MysqlConnectionConfig = ConnectionConfigBase<'mysql', SqlConnectionOptions>;
export type MssqlConnectionConfig = ConnectionConfigBase<'sqlserver', MssqlConnectionOptions>;
export type MongoConnectionConfig = ConnectionConfigBase<'mongodb', MongoConnectionOptions>;

/**
 * Discriminated on `type`, so `options` narrows automatically:
 * a `postgres` config cannot carry Mongo's `uri`, and a `mongodb` config
 * cannot omit it.
 */
export type ConnectionConfig =
    | PostgresConnectionConfig
    | MysqlConnectionConfig
    | MssqlConnectionConfig
    | MongoConnectionConfig;

export interface TableRelation {
    childTable: string;
    childColumn: string;
    constraintName: string;
    parentTable: string;
    parentColumn: string;
}

/**
 * Generic in its config so each adapter sees only its own options shape while
 * `Database` (unparameterized) remains usable as the common base type.
 */
export abstract class Database<
    C extends ConnectionConfig = ConnectionConfig,
    P extends ExecutionPlan = ExecutionPlan,
> {
    config: C;

    constructor(config: C) {
        this.config = config;
    }

    abstract connect(): Promise<void>;

    /**
     * Runs internally-generated SQL: introspection and profiling only.
     *
     * Caller-supplied SQL must never reach this method — it takes a string and
     * so applies no governance. Agent queries go through {@link execute},
     * which accepts only a gate-approved plan. Enforced by
     * tests/invariant/query-plan.test.ts.
     */
    abstract query(sql: string, params?: QueryParams): Promise<unknown>;

    /**
     * Runs a plan approved by a governance gate. The only path by which a
     * caller-supplied query reaches a driver (architecture.md §7 invariant 1).
     */
    abstract execute(plan: P, options?: ExecuteOptions): Promise<unknown>;

    /** Tables and views, without their columns. */
    abstract listTables(): Promise<TableInfo[]>;

    /**
     * Columns, uniformly shaped across engines. With no argument, returns
     * every column of every table — each carrying its own `table`, so the
     * result is attributable (B7).
     */
    abstract getSchema(tableName?: string): Promise<ColumnInfo[]>;

    abstract getRelations(databaseName?: string): Promise<TableRelation[]>;

    /**
     * Statistical profile of a table's columns (spec.md R3.8).
     * With no `columns`, profiles every column of the table.
     */
    abstract profile(
        table: string,
        columns?: string[],
        options?: ProfileOptions,
    ): Promise<ColumnProfile[]>;
}
