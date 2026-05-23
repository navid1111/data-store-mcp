
import { z } from 'zod';
import { ConnectionManager } from '../../connection-utils.js';

export const inspectDatabaseTool = {
    name: 'inspect_database',
    description: 'Inspect a connected database (SQL tables/relationships or MongoDB collections/indexes)',
    inputSchema: {
        type: 'object',
        properties: {
            connectionId: { type: 'string', description: 'Connection ID to inspect' },
            name: {
                type: 'string',
                description: 'Optional table or collection name to inspect',
            },
        },
        required: ['connectionId'],
    },
    handler: async (args: unknown) => {
        const schema = z.object({
            connectionId: z.string(),
            name: z.string().optional(),
        });

        const parsed = schema.parse(args);
        const connectionId = parsed.connectionId;
        const db = ConnectionManager.getInstance().getConnection(connectionId);

        if (!db) {
            throw new Error(`Connection with ID ${connectionId} not found`);
        }

        const [schemaResult, relations] = await Promise.all([
            db.getSchema(parsed.name),
            db.getRelations()
        ]);

        if (db.config.type === 'mongodb') {
            return {
                connectionId,
                type: db.config.type,
                database: db.config.options.database,
                collections: schemaResult,
                relationships: relations,
            };
        }

        return {
            connectionId,
            type: db.config.type,
            tables: schemaResult,
            relations,
        };
    },
};
