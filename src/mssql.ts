
import { Database, ConnectionConfig, TableRelation } from "./database-source.js";
import sql from 'mssql';

export class MssqlDatabase extends Database {
    private pool: sql.ConnectionPool | null = null;

    constructor(config: ConnectionConfig) {
        super(config);
    }

    async connect(): Promise<void> {
        const sqlConfig: sql.config = {
            user: this.config.options.user,
            password: this.config.options.password,
            database: this.config.options.database,
            server: this.config.options.host,
            port: this.config.options.port,
            pool: {
                max: 10,
                min: 0,
                idleTimeoutMillis: 30000
            },
            options: {
                encrypt: this.config.options.encrypt !== false, // Default to true unless explicitly false
                trustServerCertificate: this.config.options.TrustServerCertificate === true || this.config.options.trustServerCertificate === true // Handle both cases
            }
        };

        try {
            this.pool = await sql.connect(sqlConfig);
        } catch (err) {
            console.error('SQL Server connection error:', err);
            throw err;
        }
    }

    async query(queryString: string, params?: any): Promise<any> {
        if (!this.pool) {
            throw new Error("Database not connected");
        }

        try {
            const request = this.pool.request();

            // Handle parameters if provided
            if (params) {
                if (Array.isArray(params)) {
                    params.forEach((param, index) => {
                        request.input(`p${index}`, param);
                    });
                } else if (typeof params === 'object') {
                    Object.keys(params).forEach(key => {
                        request.input(key, params[key]);
                    });
                }
            }

            const result = await request.query(queryString);
            return result.recordset;
        } catch (err) {
            console.error('SQL Server query error:', err);
            throw err;
        }
    }

    async getSchema(tableName?: string): Promise<any> {
        if (!this.pool) {
            throw new Error("Database not connected");
        }

        const query = tableName
            ? `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @tableName`
            : `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'`;

        const request = this.pool.request();
        if (tableName) {
            request.input('tableName', sql.VarChar, tableName);
        }

        const result = await request.query(query);
        return result.recordset;
    }

    async getRelations(_databaseName?: string): Promise<TableRelation[]> {
        if (!this.pool) {
            throw new Error("Database not connected");
        }

        const query = `
            SELECT 
                tab1.name AS [childTable],
                col1.name AS [childColumn],
                obj.name AS [constraintName],
                tab2.name AS [parentTable],
                col2.name AS [parentColumn]
            FROM sys.foreign_key_columns fkc
            INNER JOIN sys.objects obj
                ON obj.object_id = fkc.constraint_object_id
            INNER JOIN sys.tables tab1
                ON tab1.object_id = fkc.parent_object_id
            INNER JOIN sys.schemas sch
                ON tab1.schema_id = sch.schema_id
            INNER JOIN sys.columns col1
                ON col1.column_id = fkc.parent_column_id AND col1.object_id = tab1.object_id
            INNER JOIN sys.tables tab2
                ON tab2.object_id = fkc.referenced_object_id
            INNER JOIN sys.columns col2
                ON col2.column_id = fkc.referenced_column_id AND col2.object_id = tab2.object_id
        `;

        const request = this.pool.request();
        const result = await request.query(query);
        return result.recordset as TableRelation[];
    }
}
