
import { z } from 'zod';
import { ConnectionManager } from '../../connection-utils.js';
import { PostgresDatabase } from '../../postgres.js';
import { MysqlDatabase } from '../../mysql.js';
import { ConnectionConfig } from '../../database-source.js';

export const connectDatabaseTool = {
    name: 'connect_database',
    description: 'Connect to a database (MySQL or PostgreSQL)',
    inputSchema: {
        type: 'object',
        properties: {
            type: {
                type: 'string',
                enum: ['mysql', 'postgres'],
                description: 'Database type',
            },
            host: { type: 'string' },
            port: { type: 'number' },
            user: { type: 'string' },
            password: { type: 'string' },
            database: { type: 'string' },
            id: { type: 'string', description: 'Optional connection ID' },
        },
        required: ['type', 'host', 'port', 'user', 'password', 'database'],
    },
    handler: async (args: unknown) => {
        const schema = z.object({
            type: z.enum(['mysql', 'postgres']),
            host: z.string(),
            port: z.number(),
            user: z.string(),
            password: z.string(),
            database: z.string(),
            id: z.string().optional(),
        });

        const parsed = schema.parse(args);
        const id = parsed.id || `${parsed.type}-${Date.now()}`;

        const config: ConnectionConfig = {
            id,
            type: parsed.type as any,
            options: {
                host: parsed.host,
                port: parsed.port,
                user: parsed.user,
                password: parsed.password,
                database: parsed.database,
            },
        };

        let db;
        if (parsed.type === 'postgres') {
            db = new PostgresDatabase(config);
        } else {
            db = new MysqlDatabase(config);
        }

        await db.connect();
        ConnectionManager.getInstance().addConnection(id, db);

        return {
            connectionId: id,
            message: `Successfully connected to ${parsed.type} database`,
        };
    },
};
