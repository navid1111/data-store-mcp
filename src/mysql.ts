
import { Database, ConnectionConfig, TableRelation } from "./database-source.js";
import { quoteMysqlIdentifier } from "./identifiers.js";
import mysql from 'mysql2/promise';

export class MysqlDatabase extends Database {
  private connection: mysql.Connection | null = null;

  constructor(config: ConnectionConfig) {
    super(config);
  }

  async connect(): Promise<void> {
    this.connection = await mysql.createConnection(this.config.options);
  }

  async query(sql: string, params?: any): Promise<any> {
    if (!this.connection) {
      throw new Error("Database not connected");
    }
    const [rows] = await this.connection.execute(sql, params);
    return rows;
  }

  async getSchema(tableName?: string): Promise<any> {
    if (!this.connection) {
      throw new Error("Database not connected");
    }

    // `DESCRIBE ?` is not valid SQL — an identifier cannot be bound — so the
    // table name is validated and backtick-quoted instead. The schema name in
    // the other branch is config-derived rather than caller-supplied, but is
    // bound anyway so no branch of this method interpolates a value.
    if (tableName !== undefined) {
      return this.query(`DESCRIBE ${quoteMysqlIdentifier(tableName, 'table name')}`);
    }

    return this.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = ?`,
      [this.config.options.database]
    );
  }

  async getRelations(databaseName: string): Promise<TableRelation[]> {
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