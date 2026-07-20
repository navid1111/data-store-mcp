
import {
    Database,
    MssqlConnectionConfig,
    QueryParams,
    Row,
    TableRelation,
} from "./database-source.js";
import type { ColumnInfo, ColumnProfile, ProfileOptions, TableInfo } from "./sources/types.js";
import { assertValidIdentifier, quotePostgresIdentifier } from "./identifiers.js";
import { profileSqlColumns } from "./sources/profile-sql.js";
import type { ExecuteOptions, QueryPlan } from "./governance/plan.js";
import sql from 'mssql';

export class MssqlDatabase extends Database<MssqlConnectionConfig, QueryPlan> {
    private pool: sql.ConnectionPool | null = null;

    constructor(config: MssqlConnectionConfig) {
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

    async query(queryString: string, params?: QueryParams): Promise<Row[]> {
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
                } else {
                    Object.entries(params).forEach(([key, value]) => {
                        request.input(key, value);
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

    async execute(plan: QueryPlan, _options?: ExecuteOptions): Promise<Row[]> {
        return this.query(plan.sql, [...plan.params]);
    }

    async listTables(): Promise<TableInfo[]> {
        if (!this.pool) {
            throw new Error("Database not connected");
        }

        const result = await this.pool.request().query(`
            SELECT
                t.name                       AS name,
                s.name                       AS table_schema,
                'table'                      AS kind,
                CAST(p.value AS NVARCHAR(MAX)) AS comment,
                SUM(ps.row_count)            AS estimated_row_count
            FROM sys.tables t
            JOIN sys.schemas s ON s.schema_id = t.schema_id
            LEFT JOIN sys.extended_properties p
              ON p.major_id = t.object_id AND p.minor_id = 0 AND p.name = 'MS_Description'
            LEFT JOIN sys.dm_db_partition_stats ps
              ON ps.object_id = t.object_id AND ps.index_id IN (0, 1)
            GROUP BY t.name, s.name, CAST(p.value AS NVARCHAR(MAX))
            UNION ALL
            SELECT v.name, s.name, 'view', NULL, NULL
            FROM sys.views v
            JOIN sys.schemas s ON s.schema_id = v.schema_id
            ORDER BY name
        `);

        return (result.recordset as Row[]).map((r) => ({
            name: String(r.name),
            schema: String(r.table_schema),
            kind: r.kind === 'view' ? ('view' as const) : ('table' as const),
            ...(r.comment != null ? { comment: String(r.comment) } : {}),
            ...(r.estimated_row_count != null
                ? { estimatedRowCount: Number(r.estimated_row_count) }
                : {}),
        }));
    }

    async getSchema(tableName?: string): Promise<ColumnInfo[]> {
        if (!this.pool) {
            throw new Error("Database not connected");
        }

        if (tableName !== undefined) {
            assertValidIdentifier(tableName, 'table name');
        }

        const request = this.pool.request();
        request.input('tableName', sql.VarChar, tableName ?? null);

        const result = await request.query(`
            SELECT
                t.name                          AS table_name,
                c.name                          AS name,
                TYPE_NAME(c.user_type_id)       AS data_type,
                c.is_nullable                   AS is_nullable,
                c.column_id                     AS position,
                dc.definition                   AS default_value,
                CAST(p.value AS NVARCHAR(MAX))  AS comment,
                CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key,
                CASE WHEN uq.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_unique
            FROM sys.columns c
            JOIN sys.tables t ON t.object_id = c.object_id
            LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
            LEFT JOIN sys.extended_properties p
              ON p.major_id = c.object_id AND p.minor_id = c.column_id
             AND p.name = 'MS_Description'
            LEFT JOIN (
                SELECT ic.object_id, ic.column_id
                FROM sys.index_columns ic
                JOIN sys.indexes i
                  ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                WHERE i.is_primary_key = 1
            ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
            LEFT JOIN (
                SELECT ic.object_id, MIN(ic.column_id) AS column_id
                FROM sys.index_columns ic
                JOIN sys.indexes i
                  ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                WHERE i.is_unique = 1 AND i.is_primary_key = 0
                GROUP BY ic.object_id, ic.index_id
                HAVING COUNT(*) = 1
            ) uq ON uq.object_id = c.object_id AND uq.column_id = c.column_id
            WHERE (@tableName IS NULL OR t.name = @tableName)
            ORDER BY t.name, c.column_id
        `);

        return (result.recordset as Row[]).map((r) => ({
            table: String(r.table_name),
            name: String(r.name),
            dataType: String(r.data_type),
            nullable: Boolean(r.is_nullable),
            isPrimaryKey: Boolean(Number(r.is_primary_key)),
            isUnique: Boolean(Number(r.is_unique)),
            position: Number(r.position),
            ...(r.default_value != null ? { defaultValue: String(r.default_value) } : {}),
            ...(r.comment != null ? { comment: String(r.comment) } : {}),
        }));
    }

    async profile(
        table: string,
        columns?: string[],
        options?: ProfileOptions,
    ): Promise<ColumnProfile[]> {
        const all = await this.getSchema(table);
        const selected = columns ? all.filter((c) => columns.includes(c.name)) : all;

        // T-SQL quotes identifiers with [brackets], but also accepts the ANSI
        // double-quote form used here when QUOTED_IDENTIFIER is ON (the
        // default for the mssql driver). Untested — SQL Server is deferred.
        return profileSqlColumns({
            quote: quotePostgresIdentifier,
            query: (sql) => this.query(sql),
            table,
            columns: selected,
            options,
        });
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
