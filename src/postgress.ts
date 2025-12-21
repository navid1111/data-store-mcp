import { Client } from 'pg';
import { Database } from './database-source'

export class Postgres extends Database {
  connection: Client;
  
  async connect() {
    this.connection = new Client(this.config.options);
    await this.connection.connect();
  }
  
  async query(sql: string, params?: any) {
    const result = await this.connection.query(sql, params);
    return result.rows;
  }
  
  async getSchema(tableName?: string) {
    if (tableName) {
      // Get one table
      const columns = await this.connection.query(
        'SELECT * FROM information_schema.columns WHERE table_name = $1',
        [tableName]
      );
      return columns.rows;
    }
    
    // Get all tables
    const result = await this.connection.query(
      'SELECT * FROM information_schema.columns'
    );
    return result.rows;
  }
  
  async close() {
    if (this.connection) {
      await this.connection.end();
    }
  }
}