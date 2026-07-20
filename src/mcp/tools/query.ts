
import { z } from 'zod';
import { buildPlan, dialectFor } from '../../governance/gate.js';
import { buildMongoPlan } from '../../governance/mongo.js';
import { SourceRegistry } from '../../sources/registry.js';
import { executeWithAudit } from '../../audit/execution.js';
import { performance } from 'node:perf_hooks';
import type { SemanticRegistry } from '../../semantic/registry.js';

export const queryDatabaseTool = {
    name: 'query',
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
            question: {
                type: 'string',
                description: 'Optional natural-language question saved with successful prior art',
            },
        },
        required: ['connectionId'],
    },
    handler: async (args: unknown) => {
        const registry = SourceRegistry.getInstance();
        const initial = auditContextFrom(args);

        return executeWithAudit<unknown>(registry.getAuditLog(), initial, async (audit) => {
            const schema = z.object({
                connectionId: z.string(),
                sql: z.string().optional(),
                query: z.record(z.any()).optional(),
                params: z.array(z.any()).optional(),
                question: z.string().trim().min(1).optional(),
            });

            const parsed = schema.parse(args);
            audit.source = parsed.connectionId;
            const db = registry.getSource(parsed.connectionId);

            if (!db) {
                throw new Error(`Source not found: ${parsed.connectionId}`);
            }

            if (db.config.type !== 'mongodb' && !parsed.sql) {
                throw new Error('SQL connections require sql');
            }

            if (db.config.type === 'mongodb') {
                const plan = buildMongoPlan(parsed.query ?? parsed.sql);
                audit.sql = JSON.stringify(plan.payload);
                audit.appliedPolicies.push(...plan.appliedPolicies);
                const structure = await db.getSchema(plan.payload.collection);
                const results = await db.execute(plan, registry.getExecutionOptions());

                return {
                    value: {
                        connectionId: parsed.connectionId,
                        type: db.config.type,
                        database: db.config.options.database,
                        structure,
                        query: plan.payload,
                        appliedLimit: plan.appliedLimit,
                        appliedPolicies: plan.appliedPolicies,
                        results,
                    },
                    rowCount: resultRowCount(results),
                };
            }

            // Agent SQL never reaches the driver directly: the gate parses it,
            // refuses writes, and injects a row limit, yielding a QueryPlan —
            // the only thing execute() accepts.
            const plan = buildPlan(parsed.sql || '', {
                dialect: dialectFor(db.config.type),
                params: parsed.params,
            });
            audit.sql = plan.sql;
            audit.appliedPolicies.push(...plan.appliedPolicies);

            const started = performance.now();
            const results = await db.execute(plan, registry.getExecutionOptions());
            const memory = registry.getMemoryIndex();
            if (parsed.question && memory) {
                await memory.recordExecution({
                    success: true,
                    question: parsed.question,
                    sql: plan.sql,
                    rows: memoryRows(results),
                    durationMs: Math.max(0, performance.now() - started),
                    unverifiedModels: referencedUnverifiedModels(
                        plan.sql,
                        registry.getSemanticRegistry(),
                    ),
                });
            }

            return {
                value: {
                    connectionId: parsed.connectionId,
                    type: db.config.type,
                    appliedLimit: plan.appliedLimit,
                    appliedPolicies: plan.appliedPolicies,
                    results,
                },
                rowCount: resultRowCount(results),
            };
        });
    },
};

function auditContextFrom(args: unknown): { source: string; sql: string } {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return { source: '<invalid>', sql: '' };
    }

    const raw = args as Record<string, unknown>;
    const source = typeof raw.connectionId === 'string' ? raw.connectionId : '<invalid>';
    if (typeof raw.sql === 'string') return { source, sql: raw.sql };

    try {
        return { source, sql: raw.query === undefined ? '' : JSON.stringify(raw.query) };
    } catch {
        return { source, sql: '<unserializable query>' };
    }
}

function resultRowCount(result: unknown): number {
    if (Array.isArray(result)) return result.length;
    return result === undefined || result === null ? 0 : 1;
}

function memoryRows(result: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(result)) return [];
    return result.filter((row): row is Record<string, unknown> =>
        Boolean(row && typeof row === 'object' && !Array.isArray(row)));
}

function referencedUnverifiedModels(sql: string, semantic: SemanticRegistry): string[] {
    const identifiers = new Set(sql.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []);
    return semantic.document.models
        .filter((model) => !model.verified && identifiers.has(model.table.toLowerCase()))
        .map((model) => model.name)
        .sort();
}
