
import { z } from 'zod';
import { ConnectionManager } from '../../connection-utils.js';

export const inspectDatabaseTool = {
    name: 'inspect_database',
    description: 'Inspect a connected database (list tables and relationships)',
    inputSchema: {
        type: 'object',
        properties: {
            connectionId: { type: 'string', description: 'Connection ID to inspect' },
        },
        required: ['connectionId'],
    },
    handler: async (args: unknown) => {
        const schema = z.object({
            connectionId: z.string(),
        });

        const parsed = schema.parse(args);
        const connectionId = parsed.connectionId;
        const db = ConnectionManager.getInstance().getConnection(connectionId);

        if (!db) {
            throw new Error(`Connection with ID ${connectionId} not found`);
        }

        const [tables, relations] = await Promise.all([
            db.getSchema(),
            db.getRelations()
        ]);

        return {
            connectionId,
            tables,
            relations,
        };
    },
};
