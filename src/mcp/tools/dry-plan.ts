import sqlParser from 'node-sql-parser';
import { z } from 'zod';
import { buildPlan, dialectFor } from '../../governance/gate.js';
import { unknownColumn, unverifiedModel } from '../../governance/errors.js';
import { resolveColumn, resolveModel, suggestNames } from '../../semantic/resolve.js';
import { SourceRegistry } from '../../sources/registry.js';

const { Parser } = sqlParser;

export const dryPlanTool = {
    name: 'dry_plan',
    description: 'Validate and resolve a SQL query against the semantic model without executing it',
    inputSchema: {
        type: 'object',
        properties: {
            connectionId: { type: 'string', description: 'Configured SQL source name' },
            sql: { type: 'string', description: 'Read-only SQL to validate' },
        },
        required: ['connectionId', 'sql'],
    },
    handler: async (args: unknown) => {
        const parsed = z.object({ connectionId: z.string(), sql: z.string() }).parse(args);
        const runtime = SourceRegistry.getInstance();
        const source = runtime.getSource(parsed.connectionId);
        if (!source) throw new Error(`Source not found: ${parsed.connectionId}`);
        if (source.config.type === 'mongodb') {
            throw new Error('dry_plan currently supports SQL semantic models only.');
        }

        const dialect = dialectFor(source.config.type);
        const plan = buildPlan(parsed.sql, { dialect });
        const registry = runtime.getSemanticRegistry();
        const parser = new Parser();
        const database = dialect === 'postgres' ? 'postgresql' : 'mysql';
        const tableNames = parser.tableList(parsed.sql, { database })
            .map(parseReference)
            .filter((reference) => reference.action.toLowerCase() === 'select')
            .map((reference) => reference.name);
        const models = [...new Set(tableNames)].map((name) => resolveModel(registry, name));
        const resolvedColumns: string[] = [];

        for (const reference of parser.columnList(parsed.sql, { database }).map(parseReference)) {
            if (reference.name === '(.*)') continue;
            const candidates = reference.owner
                ? models.filter((model) => model.name === reference.owner)
                : models;
            const matches = candidates.flatMap((model) => {
                try {
                    return [{ model, column: resolveColumn(model, reference.name) }];
                } catch {
                    return [];
                }
            });
            if (matches.length !== 1) {
                throw unknownColumn(reference.name, suggestNames(
                    reference.name,
                    candidates.flatMap((model) => model.columns.map((column) => column.name)),
                ));
            }
            resolvedColumns.push(`${matches[0].model.name}.${matches[0].column.name}`);
        }

        return {
            connectionId: parsed.connectionId,
            sql: plan.sql,
            resolvedTables: models.map((model) => model.name),
            resolvedColumns: [...new Set(resolvedColumns)],
            appliedLimit: plan.appliedLimit,
            appliedPolicies: plan.appliedPolicies,
            warnings: models
                .filter((model) => !model.verified)
                .map((model) => unverifiedModel(model.name).detail),
        };
    },
};

function parseReference(value: string): { action: string; owner: string | null; name: string } {
    const [action, owner, name] = value.split('::');
    return { action, owner: owner === 'null' ? null : owner, name };
}
