
import { z } from 'zod';
import { ConnectionManager } from '../../connection-utils.js';
import { PostgresDatabase } from '../../postgres.js';
import { MysqlDatabase } from '../../mysql.js';
import { MongoDatabase } from '../../mongodb.js';
import { ConnectionConfig } from '../../database-source.js';

export const connectDatabaseTool = {
    name: 'connect_database',
    description: 'Connect to a database (MySQL, PostgreSQL, or MongoDB)',
    inputSchema: {
        type: 'object',
        properties: {
            type: {
                type: 'string',
                enum: ['mysql', 'postgres', 'mongodb'],
                description: 'Database type',
            },
            uri: {
                type: 'string',
                description: 'MongoDB connection URI',
            },
            host: { type: 'string' },
            port: { type: 'number' },
            user: { type: 'string' },
            password: { type: 'string' },
            database: { type: 'string' },
            id: { type: 'string', description: 'Optional connection ID' },
        },
        required: ['type', 'database'],
    },
    handler: async (args: unknown) => {
        const schema = z.object({
            type: z.enum(['mysql', 'postgres', 'mongodb']),
            uri: z.string().optional(),
            host: z.string().optional(),
            port: z.number().optional(),
            user: z.string().optional(),
            password: z.string().optional(),
            database: z.string(),
            id: z.string().optional(),
        }).superRefine((value, ctx) => {
            if (value.type === 'mongodb') {
                if (!value.uri) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        path: ['uri'],
                        message: 'MongoDB connections require uri',
                    });
                }
                return;
            }

            for (const field of ['host', 'port', 'user', 'password'] as const) {
                if (value[field] === undefined) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        path: [field],
                        message: `${value.type} connections require ${field}`,
                    });
                }
            }
        });

        const parsed = schema.parse(args);
        const id = parsed.id || `${parsed.type}-${Date.now()}`;

        const config: ConnectionConfig = {
            id,
            type: parsed.type as any,
            options: parsed.type === 'mongodb'
                ? {
                    uri: parsed.uri,
                    database: parsed.database,
                }
                : {
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
        } else if (parsed.type === 'mongodb') {
            db = new MongoDatabase(config);
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
