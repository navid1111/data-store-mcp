

export type DatabaseType = "mysql" | "postgres" | "sqlserver" | "mongodb";

export interface ConnectionConfig {
    id: string;
    type: DatabaseType;
    description?: string;
    options: any;


}

export interface QueryPayload {
    sql: string;
    params?: any;
    tableName: string;
}


export interface TableRelation {
    childTable: string;
    childColumn: string;
    constraintName: string;
    parentTable: string;
    parentColumn: string;
}

export abstract class Database {
    config: ConnectionConfig;
    constructor(config: ConnectionConfig) {
        this.config = config;
    }
    abstract connect(): Promise<void>;

    abstract query(sql: string, params?: any): Promise<any>;
    abstract getSchema(tableName?: string): Promise<any>;
    abstract getRelations(databaseName?: string): Promise<TableRelation[]>;
}
