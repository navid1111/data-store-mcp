
import { z } from 'zod';
import { ConnectionManager } from '../../connection-utils.js';

export const queryDatabaseTool = {
    name: 'query_database',
    description: 'Execute a SQL query on a connected database',
    inputSchema: {
        type: 'object',
        properties: {
            connectionId: {
                type: 'string',
                description: 'The ID of the connection to use',
            },
            sql: {
                type: 'string',
                description: 'The SQL query to execute',
            },
            params: {
                type: 'array',
                items: {},
                description: 'Optional parameters for the query',
            },
        },
        required: ['connectionId', 'sql'],
    },
    handler: async (args: unknown) => {
        const schema = z.object({
            connectionId: z.string(),
            sql: z.string(),
            params: z.array(z.any()).optional(),
        });

        const parsed = schema.parse(args);
        const db = ConnectionManager.getInstance().getConnection(parsed.connectionId);

        if (!db) {
            throw new Error(`Connection not found: ${parsed.connectionId}`);
        }

        const results = await db.query(parsed.sql, parsed.params);

        return {
            results,
        };
    },
};
