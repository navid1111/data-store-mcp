
import { z } from 'zod';
import { ConnectionManager } from '../../connection-utils.js';
import { buildPlan, dialectFor } from '../../governance/gate.js';

export const queryDatabaseTool = {
    name: 'query_database',
    description: 'Inspect structure, then execute a SQL query or read-only MongoDB query on a connected database',
    inputSchema: {
        type: 'object',
        properties: {
            connectionId: {
                type: 'string',
                description: 'The ID of the connection to use',
            },
            sql: {
                type: 'string',
                description: 'The SQL query to execute, or a MongoDB query JSON string',
            },
            query: {
                type: 'object',
                description: 'MongoDB query object for find, findOne, aggregate, countDocuments, or distinct',
            },
            params: {
                type: 'array',
                items: {},
                description: 'Optional SQL parameters',
            },
        },
        required: ['connectionId'],
    },
    handler: async (args: unknown) => {
        const schema = z.object({
            connectionId: z.string(),
            sql: z.string().optional(),
            query: z.record(z.any()).optional(),
            params: z.array(z.any()).optional(),
        });

        const parsed = schema.parse(args);
        const db = ConnectionManager.getInstance().getConnection(parsed.connectionId);

        if (!db) {
            throw new Error(`Connection not found: ${parsed.connectionId}`);
        }

        if (db.config.type !== 'mongodb' && !parsed.sql) {
            throw new Error('SQL connections require sql');
        }

        if (db.config.type === 'mongodb') {
            // Ungoverned until task 1.8 adds the Mongo gate (read-only ops,
            // forced $limit, pipeline-stage cap).
            const mongoQuery = getMongoQueryPayload(parsed.sql, parsed.query);
            const structure = await db.getSchema(mongoQuery.collection);
            const results = await db.query(parsed.sql || '{}', parsed.query);

            return {
                connectionId: parsed.connectionId,
                type: db.config.type,
                database: db.config.options.database,
                structure,
                query: mongoQuery,
                results,
            };
        }

        // Agent SQL never reaches the driver directly: the gate parses it,
        // refuses writes, and injects a row limit, yielding a QueryPlan —
        // the only thing execute() accepts.
        const plan = buildPlan(parsed.sql || '', {
            dialect: dialectFor(db.config.type),
            params: parsed.params,
        });

        const results = await db.execute(plan);

        return {
            connectionId: parsed.connectionId,
            type: db.config.type,
            appliedLimit: plan.appliedLimit,
            appliedPolicies: plan.appliedPolicies,
            results,
        };
    },
};

function getMongoQueryPayload(sql?: string, query?: Record<string, unknown>): Record<string, any> {
    const payload = query || (sql ? JSON.parse(sql) : undefined);

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('MongoDB queries require a query object or JSON object string');
    }

    if (typeof payload.collection !== 'string' || !payload.collection) {
        throw new Error('MongoDB queries require collection');
    }

    return payload;
}
