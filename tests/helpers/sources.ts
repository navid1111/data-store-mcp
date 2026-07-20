/**
 * Connection configs for the docker-compose fixture databases.
 *
 * Ports match docker-compose.yml and are non-default on purpose. Override via
 * env when pointing at something else (e.g. CI service containers).
 */

import type {
  MongoConnectionConfig,
  MysqlConnectionConfig,
  PostgresConnectionConfig,
} from '../../src/database-source.js';

const env = (key: string, fallback: string): string => process.env[key] ?? fallback;

export const PAGILA: PostgresConnectionConfig = {
  id: 'test-pagila',
  type: 'postgres',
  description: 'Pagila sample database (PostgreSQL)',
  options: {
    host: env('TEST_PG_HOST', '127.0.0.1'),
    port: Number(env('TEST_PG_PORT', '55432')),
    user: env('TEST_PG_USER', 'postgres'),
    password: env('TEST_PG_PASSWORD', 'dsm_test_pw'),
    database: env('TEST_PG_DATABASE', 'pagila'),
  },
};

export const SAKILA: MysqlConnectionConfig = {
  id: 'test-sakila',
  type: 'mysql',
  description: 'Sakila sample database (MySQL)',
  options: {
    host: env('TEST_MYSQL_HOST', '127.0.0.1'),
    port: Number(env('TEST_MYSQL_PORT', '53306')),
    user: env('TEST_MYSQL_USER', 'dsm'),
    password: env('TEST_MYSQL_PASSWORD', 'dsm_test_pw'),
    database: env('TEST_MYSQL_DATABASE', 'sakila'),
  },
};

/**
 * Mongo has no canonical equivalent of Pagila/Sakila, so integration tests seed
 * their own collections (see tests/helpers/seed-mongo.ts). Kept structurally
 * parallel to the SQL fixtures so the same assertions can be written against it.
 */
export const MONGO: MongoConnectionConfig = {
  id: 'test-mongo',
  type: 'mongodb',
  description: 'Seeded MongoDB fixture',
  options: {
    uri: env(
      'TEST_MONGO_URI',
      'mongodb://dsm:dsm_test_pw@127.0.0.1:57017/?authSource=admin'
    ),
    database: env('TEST_MONGO_DATABASE', 'dsm_test'),
  },
};

/** Row counts shared by Pagila and Sakila — both derive from the same dataset. */
export const EXPECTED = {
  film: 1000,
  actor: 200,
  customer: 599,
  category: 16,
} as const;
