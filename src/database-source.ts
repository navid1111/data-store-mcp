

export type DatabaseType = "mysql" | "nosql";

export interface ConnectionConfig {
    id:string;
    type:DatabaseType;
    description?:string;
    options:any;


}

export interface QueryPayload{
    sql:string;
    params?:any;
    tableName:string;
}


export abstract class Database{
    config:ConnectionConfig;
    constructor(config:ConnectionConfig){
        this.config = config;
    }
    abstract connect():Promise<void>;
    abstract disconnect():Promise<void>;
    abstract executeQuery(sql:string,params?:any):Promise<any>;
    abstract getSchema(tableName?:string):Promise<any>;
}