
import { Database, ConnectionConfig } from "./database-source.js";
import pg from 'pg';

export class PostgresDatabase extends Database {
    private pool: pg.Pool;

    constructor(config: ConnectionConfig) {
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

    async query(sql: string, params?: any): Promise<any> {
        const result = await this.pool.query(sql, params);
        return result.rows;
    }

    async getSchema(tableName?: string): Promise<any> {
        const sql = `
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'public' 
            ${tableName ? `AND table_name = '${tableName}'` : ''}
        `;
        return this.query(sql);
    }
}
