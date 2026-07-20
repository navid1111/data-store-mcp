
import { z } from 'zod';
import { ConnectionManager } from '../../connection-utils.js';
import { PostgresDatabase } from '../../postgres.js';
import { MysqlDatabase } from '../../mysql.js';
import { MongoDatabase } from '../../mongodb.js';
import { Database } from '../../database-source.js';

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
        const parsed = connectSchema.parse(args);
        const id = parsed.id || `${parsed.type}-${Date.now()}`;

        // Each branch constructs its own config type, so `options` is checked
        // against the right shape and no cast is needed.
        let db: Database;
        if (parsed.type === 'mongodb') {
            db = new MongoDatabase({
                id,
                type: 'mongodb',
                options: { uri: parsed.uri, database: parsed.database },
            });
        } else {
            const options = {
                host: parsed.host,
                port: parsed.port,
                user: parsed.user,
                password: parsed.password,
                database: parsed.database,
            };
            db = parsed.type === 'postgres'
                ? new PostgresDatabase({ id, type: 'postgres', options })
                : new MysqlDatabase({ id, type: 'mysql', options });
        }

        await db.connect();
        ConnectionManager.getInstance().addConnection(id, db);

        return {
            connectionId: id,
            message: `Successfully connected to ${parsed.type} database`,
        };
    },
};

/**
 * A discriminated union rather than one optional-field object with a
 * `superRefine`: it makes the parsed result narrow by `type`, which is what
 * lets the handler build each config without casting.
 */
const sqlFields = {
    host: z.string({ required_error: 'SQL connections require host' }),
    port: z.number({ required_error: 'SQL connections require port' }),
    user: z.string({ required_error: 'SQL connections require user' }),
    password: z.string({ required_error: 'SQL connections require password' }),
    database: z.string(),
    id: z.string().optional(),
};

const connectSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('postgres'), ...sqlFields }),
    z.object({ type: z.literal('mysql'), ...sqlFields }),
    z.object({
        type: z.literal('mongodb'),
        uri: z.string({ required_error: 'MongoDB connections require uri' }),
        database: z.string(),
        id: z.string().optional(),
    }),
]);
