
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

        const [tables, columns, relations] = await Promise.all([
            db.listTables(),
            db.getSchema(parsed.name),
            db.getRelations(),
        ]);

        // Columns are nested under their table rather than returned as a flat
        // list. A flat list was unattributable when no table was named (B7):
        // the agent received 50+ columns with no way to tell them apart.
        const byTable = new Map<string, typeof columns>();
        for (const column of columns) {
            const existing = byTable.get(column.table);
            if (existing) {
                existing.push(column);
            } else {
                byTable.set(column.table, [column]);
            }
        }

        const selected = parsed.name
            ? tables.filter((t) => t.name === parsed.name)
            : tables;

        return {
            connectionId,
            type: db.config.type,
            database: db.config.options.database,
            tables: selected.map((table) => ({
                ...table,
                columns: byTable.get(table.name) ?? [],
            })),
            relations,
        };
    },
};
