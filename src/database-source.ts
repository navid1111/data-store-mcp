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
export abstract class Database<C extends ConnectionConfig = ConnectionConfig> {
    config: C;

    constructor(config: C) {
        this.config = config;
    }

    abstract connect(): Promise<void>;

    abstract query(sql: string, params?: QueryParams): Promise<unknown>;
    abstract getSchema(tableName?: string): Promise<unknown>;
    abstract getRelations(databaseName?: string): Promise<TableRelation[]>;
}
