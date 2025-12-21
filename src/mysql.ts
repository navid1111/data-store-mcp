
import { Database, ConnectionConfig } from "./database-source.js";
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

    const sql = tableName
      ? `DESCRIBE ${tableName}`
      : `SELECT table_name FROM information_schema.tables WHERE table_schema = '${this.config.options.database}'`;

    return this.query(sql);
  }
}