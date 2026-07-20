/** CI entry point for evaluating the checked-in golden queries on both SQL fixtures. */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Database, MysqlConnectionConfig, PostgresConnectionConfig } from '../database-source.js';
import type { Dialect } from '../governance/parse.js';
import { MysqlDatabase } from '../mysql.js';
import { parseQueriesYaml } from '../orchestrator/context.js';
import { PostgresDatabase } from '../postgres.js';
import { runGoldenEval, type GoldenEvalReport } from './golden.js';

interface EvalTarget {
    name: string;
    dialect: Dialect;
    database: Database;
    close: () => Promise<void>;
}

const queriesPath = resolve(process.env.GOLDEN_QUERIES_PATH ?? 'queries.yml');
const reportPath = resolve(process.env.GOLDEN_REPORT_PATH ?? 'artifacts/golden-eval.json');
const threshold = Number(process.env.GOLDEN_THRESHOLD ?? '1');

const postgresConfig: PostgresConnectionConfig = {
    id: 'golden-pagila',
    type: 'postgres',
    options: {
        host: process.env.TEST_PG_HOST ?? '127.0.0.1',
        port: Number(process.env.TEST_PG_PORT ?? '55432'),
        user: process.env.TEST_PG_USER ?? 'postgres',
        password: process.env.TEST_PG_PASSWORD ?? 'dsm_test_pw',
        database: process.env.TEST_PG_DATABASE ?? 'pagila',
    },
};
const mysqlConfig: MysqlConnectionConfig = {
    id: 'golden-sakila',
    type: 'mysql',
    options: {
        host: process.env.TEST_MYSQL_HOST ?? '127.0.0.1',
        port: Number(process.env.TEST_MYSQL_PORT ?? '53306'),
        user: process.env.TEST_MYSQL_USER ?? 'dsm',
        password: process.env.TEST_MYSQL_PASSWORD ?? 'dsm_test_pw',
        database: process.env.TEST_MYSQL_DATABASE ?? 'sakila',
    },
};

const postgres = new PostgresDatabase(postgresConfig);
const mysql = new MysqlDatabase(mysqlConfig);
const targets: EvalTarget[] = [
    {
        name: 'postgres',
        dialect: 'postgres',
        database: postgres,
        close: async () => { await (postgres as unknown as { pool: { end(): Promise<void> } }).pool.end(); },
    },
    {
        name: 'mysql',
        dialect: 'mysql',
        database: mysql,
        close: async () => {
            await (mysql as unknown as { connection: { end(): Promise<void> } | null }).connection?.end();
        },
    },
];

const reports: Record<string, GoldenEvalReport> = {};
try {
    const queries = parseQueriesYaml(await readFile(queriesPath, 'utf8'), queriesPath);
    await Promise.all(targets.map((target) => target.database.connect()));
    for (const target of targets) {
        const report = await runGoldenEval(target.database, queries, {
            dialect: target.dialect,
            threshold,
        });
        reports[target.name] = report;
        process.stdout.write(`${target.name}: ${report.output}`);
    }
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        queriesPath,
        threshold,
        reports,
    }, null, 2)}\n`, 'utf8');
    if (Object.values(reports).some((report) => report.exitCode !== 0)) process.exitCode = 1;
} catch (error) {
    process.stderr.write(`Golden evaluation failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
} finally {
    await Promise.all(targets.map((target) => target.close().catch(() => undefined)));
}
