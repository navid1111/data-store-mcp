
import { Database, PostgresConnectionConfig, Row, TableRelation } from "./database-source.js";
import type { ColumnInfo, ColumnProfile, ProfileOptions, TableInfo } from "./sources/types.js";
import { assertValidIdentifier, quotePostgresIdentifier } from "./identifiers.js";
import { profileSqlColumns } from "./sources/profile-sql.js";
import pg from 'pg';

/**
 * Only the default schema is introspected. Multi-schema support is a separate
 * concern from the uniform-shape work in task 0.5.
 */
const SCHEMA = 'public';

function toColumnInfo(r: Row): ColumnInfo {
    return {
        table: String(r.table),
        name: String(r.name),
        dataType: String(r.data_type),
        nullable: Boolean(r.nullable),
        isPrimaryKey: Boolean(r.is_primary_key),
        isUnique: Boolean(r.is_unique),
        position: Number(r.position),
        ...(r.default_value != null ? { defaultValue: String(r.default_value) } : {}),
        ...(r.comment != null ? { comment: String(r.comment) } : {}),
    };
}

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

    async listTables(): Promise<TableInfo[]> {
        const rows = await this.query(`
            SELECT
                c.relname                                    AS name,
                n.nspname                                    AS schema,
                CASE WHEN c.relkind IN ('v', 'm') THEN 'view'
                     ELSE 'table' END                        AS kind,
                obj_description(c.oid)                       AS comment,
                CASE WHEN c.reltuples < 0 THEN NULL
                     ELSE c.reltuples::bigint END            AS estimated_row_count
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm')
            ORDER BY c.relname
        `, [SCHEMA]);

        return rows.map((r) => ({
            name: String(r.name),
            schema: String(r.schema),
            kind: r.kind === 'view' ? ('view' as const) : ('table' as const),
            ...(r.comment != null ? { comment: String(r.comment) } : {}),
            ...(r.estimated_row_count != null
                ? { estimatedRowCount: Number(r.estimated_row_count) }
                : {}),
        }));
    }

    async getSchema(tableName?: string): Promise<ColumnInfo[]> {
        // Validated for a consistent contract across adapters, and bound as a
        // parameter so the value never reaches the query string. Either alone
        // would close the injection; both keep the behaviour uniform with
        // MySQL, where binding is impossible (see identifiers.ts).
        if (tableName !== undefined) {
            assertValidIdentifier(tableName, 'table name');
        }

        // pg_catalog rather than information_schema: `col_description` needs
        // the pg_class oid, and pg_index reports every column of a composite
        // primary key rather than only the first.
        const rows = await this.query(`
            SELECT
                c.relname                             AS table,
                a.attname                             AS name,
                format_type(a.atttypid, a.atttypmod)  AS data_type,
                NOT a.attnotnull                      AS nullable,
                a.attnum                              AS position,
                pg_get_expr(ad.adbin, ad.adrelid)     AS default_value,
                col_description(c.oid, a.attnum)      AS comment,
                COALESCE(pk.hit, false)               AS is_primary_key,
                COALESCE(uq.hit, false)               AS is_unique
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_attribute a
              ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
            LEFT JOIN LATERAL (
                SELECT true AS hit FROM pg_index i
                WHERE i.indrelid = c.oid AND i.indisprimary
                  AND a.attnum = ANY (i.indkey::smallint[])
                LIMIT 1
            ) pk ON true
            LEFT JOIN LATERAL (
                SELECT true AS hit FROM pg_index i
                WHERE i.indrelid = c.oid AND i.indisunique
                  AND array_length(i.indkey::smallint[], 1) = 1
                  AND a.attnum = ANY (i.indkey::smallint[])
                LIMIT 1
            ) uq ON true
            WHERE n.nspname = $1
              AND c.relkind IN ('r', 'p', 'v', 'm')
              AND ($2::text IS NULL OR c.relname = $2)
            ORDER BY c.relname, a.attnum
        `, [SCHEMA, tableName ?? null]);

        return rows.map(toColumnInfo);
    }

    async profile(
        table: string,
        columns?: string[],
        options?: ProfileOptions,
    ): Promise<ColumnProfile[]> {
        const all = await this.getSchema(table);
        const selected = columns
            ? all.filter((c) => columns.includes(c.name))
            : all;

        return profileSqlColumns({
            quote: quotePostgresIdentifier,
            query: (sql) => this.query(sql),
            table,
            columns: selected,
            options,
        });
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
