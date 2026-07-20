/** Config-driven live source registry (spec R8.1/R8.2). */

import type { ConnectionConfig, Database, DatabaseType } from '../database-source.js';
import { MongoDatabase } from '../mongodb.js';
import { MysqlDatabase } from '../mysql.js';
import { PostgresDatabase } from '../postgres.js';

export interface SourceDescriptor {
    name: string;
    type: Exclude<DatabaseType, 'sqlserver'>;
    description?: string;
}

export class SourceRegistry {
    private static instance: SourceRegistry | undefined;
    private readonly sources: Map<string, Database>;

    private constructor(sources: Map<string, Database>) {
        this.sources = sources;
    }

    /** Connect every configured source before publishing the registry. */
    static async initialize(configs: ConnectionConfig[]): Promise<SourceRegistry> {
        const sources = new Map<string, Database>();

        for (const config of configs) {
            if (sources.has(config.id)) {
                throw new Error(`Duplicate source name: ${config.id}`);
            }

            const database = createDatabase(config);
            await database.connect();
            sources.set(config.id, database);
        }

        const registry = new SourceRegistry(sources);
        SourceRegistry.instance = registry;
        return registry;
    }

    static getInstance(): SourceRegistry {
        if (!SourceRegistry.instance) {
            throw new Error('Source registry has not been initialized.');
        }
        return SourceRegistry.instance;
    }

    getSource(name: string): Database | undefined {
        return this.sources.get(name);
    }

    /**
     * Returns an allowlisted public shape. Never derive this by spreading or
     * deleting fields from Database.config: credentials must be impossible to
     * serialize even if new config fields are added later.
     */
    listSources(): SourceDescriptor[] {
        return [...this.sources.values()]
            .map((database): SourceDescriptor => ({
                name: database.config.id,
                type: asSupportedType(database.config.type),
                ...(database.config.description
                    ? { description: database.config.description }
                    : {}),
            }))
            .sort((left, right) => left.name.localeCompare(right.name));
    }
}

function createDatabase(config: ConnectionConfig): Database {
    switch (config.type) {
        case 'postgres':
            return new PostgresDatabase(config);
        case 'mysql':
            return new MysqlDatabase(config);
        case 'mongodb':
            return new MongoDatabase(config);
        case 'sqlserver':
            throw new Error('SQL Server is outside the configured source scope.');
    }
}

function asSupportedType(type: DatabaseType): SourceDescriptor['type'] {
    if (type === 'sqlserver') {
        throw new Error('SQL Server is outside the configured source scope.');
    }
    return type;
}
