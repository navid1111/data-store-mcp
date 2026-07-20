/**
 * T0.2 criterion 2 — type-level tests for the ConnectionConfig union.
 *
 * There are no runtime assertions here: the test *is* that `tsc` accepts the
 * valid cases and that every `@ts-expect-error` line actually errors. An unused
 * `@ts-expect-error` is itself a compile error, so a union that stopped
 * discriminating would fail the build.
 *
 * Verified by `npm run typecheck` via tsconfig.test.json, not by vitest.
 */

import type {
    ConnectionConfig,
    MongoConnectionConfig,
    MysqlConnectionConfig,
    PostgresConnectionConfig,
} from '../../src/database-source.js';
import { MongoDatabase } from '../../src/mongodb.js';
import { MysqlDatabase } from '../../src/mysql.js';
import { PostgresDatabase } from '../../src/postgres.js';

// ---------------------------------------------------------------- valid cases

export const validPostgres: PostgresConnectionConfig = {
    id: 'pg',
    type: 'postgres',
    options: { host: 'h', port: 5432, user: 'u', password: 'p', database: 'd' },
};

export const validMongo: MongoConnectionConfig = {
    id: 'mongo',
    type: 'mongodb',
    options: { uri: 'mongodb://h/db', database: 'd' },
};

// Each member is assignable to the union.
export const asUnion: ConnectionConfig[] = [validPostgres, validMongo];

// ------------------------------------------------------------- invalid cases

// A postgres config cannot carry Mongo's `uri`.
export const pgWithUri: PostgresConnectionConfig = {
    id: 'pg',
    type: 'postgres',
    // @ts-expect-error - `uri` does not exist on SqlConnectionOptions
    options: { host: 'h', port: 5432, user: 'u', password: 'p', database: 'd', uri: 'x' },
};

// A mongodb config cannot omit `uri`.
export const mongoWithoutUri: MongoConnectionConfig = {
    id: 'mongo',
    type: 'mongodb',
    // @ts-expect-error - `uri` is required
    options: { database: 'd' },
};

// A postgres config cannot omit credentials.
export const pgWithoutPassword: PostgresConnectionConfig = {
    id: 'pg',
    type: 'postgres',
    // @ts-expect-error - `password` is required
    options: { host: 'h', port: 5432, user: 'u', database: 'd' },
};

// `port` is a number, not a string.
export const pgStringPort: PostgresConnectionConfig = {
    id: 'pg',
    type: 'postgres',
    // @ts-expect-error - `port` must be a number
    options: { host: 'h', port: '5432', user: 'u', password: 'p', database: 'd' },
};

// The discriminant and the options shape must agree.
// @ts-expect-error - mongodb options with a postgres discriminant
export const mismatched: PostgresConnectionConfig = validMongo;

// ------------------------------------------------- adapters reject wrong config

// @ts-expect-error - PostgresDatabase does not accept a Mongo config
export const wrongAdapter = new PostgresDatabase(validMongo);

// @ts-expect-error - MongoDatabase does not accept a Postgres config
export const wrongAdapter2 = new MongoDatabase(validPostgres);

// A MySQL config is structurally identical to Postgres' but discriminated apart.
export const mysqlConfig: MysqlConnectionConfig = {
    id: 'my',
    type: 'mysql',
    options: { host: 'h', port: 3306, user: 'u', password: 'p', database: 'd' },
};

// @ts-expect-error - MysqlDatabase does not accept a Postgres config
export const wrongAdapter3 = new MysqlDatabase(validPostgres);

// ------------------------------------------------------ base type still usable

import type { Database } from '../../src/database-source.js';

export const asBase: Database[] = [
    new PostgresDatabase(validPostgres),
    new MysqlDatabase(mysqlConfig),
    new MongoDatabase(validMongo),
];
