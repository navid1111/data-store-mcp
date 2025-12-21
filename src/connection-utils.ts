
import { Database } from "./database-source.js";

export class ConnectionManager {
    private static instance: ConnectionManager;
    private connections: Map<string, Database> = new Map();

    private constructor() { }

    public static getInstance(): ConnectionManager {
        if (!ConnectionManager.instance) {
            ConnectionManager.instance = new ConnectionManager();
        }
        return ConnectionManager.instance;
    }

    public addConnection(id: string, database: Database): void {
        this.connections.set(id, database);
    }

    public getConnection(id: string): Database | undefined {
        return this.connections.get(id);
    }

    public removeConnection(id: string): boolean {
        return this.connections.delete(id);
    }

    public getConnections(): string[] {
        return Array.from(this.connections.keys());
    }
}
