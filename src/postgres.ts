
import { Database, PostgresConnectionConfig, Row, TableRelation } from "./database-source.js";
import { assertValidIdentifier } from "./identifiers.js";
import pg from 'pg';

export class PostgresDatabase extends Database<PostgresConnectionConfig> {
    private pool: pg.Pool;

    constructor(config: PostgresConnectionConfig) {
        super(config);
        this.pool = new pg.Pool(config.options);
    }

    async connect(): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('SELECT 1');
        } finally {
            client.release();
        }
    }

    async query(sql: string, params?: unknown[]): Promise<Row[]> {
        const result = await this.pool.query(sql, params);
        return result.rows;
    }

    async getSchema(tableName?: string): Promise<Row[]> {
        // Validated for a consistent contract across adapters, and bound as a
        // parameter so the value never reaches the query string. Either alone
        // would close the injection; both keep the behaviour uniform with
        // MySQL, where binding is impossible (see identifiers.ts).
        if (tableName !== undefined) {
            assertValidIdentifier(tableName, 'table name');
        }

        const sql = `
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'public'
            ${tableName ? 'AND table_name = $1' : ''}
        `;
        return this.query(sql, tableName ? [tableName] : undefined);
    }

    async getRelations(_databaseName?: string): Promise<TableRelation[]> {
        const sql = `
            SELECT
                kcu.table_name as "childTable",
                kcu.column_name as "childColumn",
                tc.constraint_name as "constraintName",
                ccu.table_name as "parentTable",
                ccu.column_name as "parentColumn"
            FROM 
                information_schema.table_constraints AS tc 
                JOIN information_schema.key_column_usage AS kcu
                  ON tc.constraint_name = kcu.constraint_name
                  AND tc.table_schema = kcu.table_schema
                JOIN information_schema.constraint_column_usage AS ccu
                  ON ccu.constraint_name = tc.constraint_name
                  AND ccu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public';
        `;
        const result = await this.pool.query(sql);
        return result.rows as TableRelation[];
    }
}
