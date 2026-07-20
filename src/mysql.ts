
import { Database, MysqlConnectionConfig, Row, TableRelation } from "./database-source.js";
import type { ColumnInfo, ColumnProfile, ProfileOptions, TableInfo } from "./sources/types.js";
import { assertValidIdentifier, quoteMysqlIdentifier } from "./identifiers.js";
import { profileSqlColumns } from "./sources/profile-sql.js";
import { resolveTimeoutMs, type ExecuteOptions, type QueryPlan } from "./governance/plan.js";
import { timeout as governanceTimeout } from "./governance/errors.js";
import mysql from 'mysql2/promise';

export class MysqlDatabase extends Database<MysqlConnectionConfig> {
  private connection: mysql.Connection | null = null;

  constructor(config: MysqlConnectionConfig) {
    super(config);
  }

  async connect(): Promise<void> {
    this.connection = await mysql.createConnection(this.config.options);
  }

  async query(sql: string, params?: unknown[]): Promise<Row[]> {
    if (!this.connection) {
      throw new Error("Database not connected");
    }
    const [rows] = await this.connection.execute(sql, params);
    return rows as Row[];
  }

  async execute(plan: QueryPlan, options?: ExecuteOptions): Promise<Row[]> {
    if (!this.connection) {
      throw new Error("Database not connected");
    }

    const timeoutMs = resolveTimeoutMs(options);

    // max_execution_time is enforced by the server, so the query is genuinely
    // cancelled and the connection survives. Caveat: MySQL exempts SLEEP()
    // and non-read-only statements from it — the latter cannot reach here
    // because the gate refuses writes, but it does mean this is not a
    // universal wall-clock guarantee the way statement_timeout is.
    await this.connection.query(`SET SESSION max_execution_time = ${timeoutMs}`);
    try {
      const [rows] = await this.connection.execute(plan.sql, [...plan.params]);
      return rows as Row[];
    } catch (error) {
      // 3024 = ER_QUERY_TIMEOUT
      if ((error as { errno?: number })?.errno === 3024) {
        throw governanceTimeout(timeoutMs);
      }
      throw error;
    } finally {
      await this.connection
        .query('SET SESSION max_execution_time = 0')
        .catch(() => undefined);
    }
  }

  async listTables(): Promise<TableInfo[]> {
    if (!this.connection) {
      throw new Error("Database not connected");
    }

    const rows = await this.query(`
      SELECT
        TABLE_NAME                 AS name,
        TABLE_SCHEMA               AS table_schema,
        TABLE_TYPE                 AS table_type,
        NULLIF(TABLE_COMMENT, '')  AS comment,
        TABLE_ROWS                 AS estimated_row_count
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME
    `, [this.config.options.database]);

    return rows.map((r) => ({
      name: String(r.name),
      schema: String(r.table_schema),
      kind: r.table_type === 'VIEW' ? ('view' as const) : ('table' as const),
      ...(r.comment != null ? { comment: String(r.comment) } : {}),
      ...(r.estimated_row_count != null
        ? { estimatedRowCount: Number(r.estimated_row_count) }
        : {}),
    }));
  }

  async getSchema(tableName?: string): Promise<ColumnInfo[]> {
    if (!this.connection) {
      throw new Error("Database not connected");
    }

    // Validated even though it is bound below, so an invalid identifier fails
    // the same way here as it does on Postgres.
    if (tableName !== undefined) {
      assertValidIdentifier(tableName, 'table name');
    }

    const database = this.config.options.database;

    // Key flags come from STATISTICS rather than COLUMN_KEY: COLUMN_KEY marks
    // 'UNI' only on the first column of a unique index, and is ambiguous when
    // a column belongs to several indexes.
    const rows = await this.query(`
      SELECT
        c.TABLE_NAME                  AS table_name,
        c.COLUMN_NAME                 AS name,
        c.DATA_TYPE                   AS data_type,
        c.IS_NULLABLE                 AS is_nullable,
        c.ORDINAL_POSITION            AS position,
        c.COLUMN_DEFAULT              AS default_value,
        NULLIF(c.COLUMN_COMMENT, '')  AS comment,
        (pk.COLUMN_NAME IS NOT NULL)  AS is_primary_key,
        (uq.COLUMN_NAME IS NOT NULL)  AS is_unique
      FROM information_schema.COLUMNS c
      LEFT JOIN information_schema.STATISTICS pk
        ON  pk.TABLE_SCHEMA = c.TABLE_SCHEMA
        AND pk.TABLE_NAME   = c.TABLE_NAME
        AND pk.COLUMN_NAME  = c.COLUMN_NAME
        AND pk.INDEX_NAME   = 'PRIMARY'
      LEFT JOIN (
        SELECT s.TABLE_SCHEMA, s.TABLE_NAME, s.COLUMN_NAME
        FROM information_schema.STATISTICS s
        JOIN (
          SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME
          FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY'
          GROUP BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME
          HAVING COUNT(*) = 1
        ) single
          ON  single.TABLE_SCHEMA = s.TABLE_SCHEMA
          AND single.TABLE_NAME   = s.TABLE_NAME
          AND single.INDEX_NAME   = s.INDEX_NAME
        WHERE s.TABLE_SCHEMA = ?
      ) uq
        ON  uq.TABLE_SCHEMA = c.TABLE_SCHEMA
        AND uq.TABLE_NAME   = c.TABLE_NAME
        AND uq.COLUMN_NAME  = c.COLUMN_NAME
      WHERE c.TABLE_SCHEMA = ?
        AND (? IS NULL OR c.TABLE_NAME = ?)
      ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
    `, [database, database, database, tableName ?? null, tableName ?? null]);

    return rows.map((r) => ({
      table: String(r.table_name),
      name: String(r.name),
      dataType: String(r.data_type),
      nullable: r.is_nullable === 'YES',
      // MySQL returns 1/0 for boolean expressions, not true/false.
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

    return profileSqlColumns({
      quote: quoteMysqlIdentifier,
      query: (sql) => this.query(sql),
      table,
      columns: selected,
      options,
    });
  }

  async getRelations(databaseName?: string): Promise<TableRelation[]> {
    if (!this.connection) {
      throw new Error("Database not connected");
    }

    const sql = `
      SELECT 
        TABLE_NAME as childTable,
        COLUMN_NAME as childColumn,
        CONSTRAINT_NAME as constraintName,
        REFERENCED_TABLE_NAME as parentTable,
        REFERENCED_COLUMN_NAME as parentColumn
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE 
        REFERENCED_TABLE_NAME IS NOT NULL
        AND TABLE_SCHEMA = ?
    `;

    const [rows] = await this.connection.execute(sql, [databaseName || this.config.options.database]);
    return rows as TableRelation[];
  }
}