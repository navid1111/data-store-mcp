/** MDL selection to dialect-correct, bounded SQL (spec R3.4/R2.3). */

import { quoteMysqlIdentifier, quotePostgresIdentifier } from '../identifiers.js';
import type { Dialect } from '../governance/parse.js';
import type { SemanticRegistry } from './registry.js';
import type { Column, Metric, Model } from './types.js';

export interface DimensionSelection {
    model: string;
    column: string;
}

export interface SemanticSelection {
    metric: string;
    dimensions?: readonly DimensionSelection[];
    limit?: number;
}

export interface CompiledSemanticQuery {
    sql: string;
    metric: Metric;
    models: string[];
    appliedLimit: number;
}

const AGGREGATE = /^(COUNT|SUM|AVG|MIN|MAX)\(\s*(DISTINCT\s+)?(\*|[A-Za-z_][A-Za-z0-9_]*)\s*\)$/i;
const DEFAULT_LIMIT = 1_000;
const MAX_LIMIT = 10_000;

export function compileSelection(
    registry: SemanticRegistry,
    selection: SemanticSelection,
    dialect: Dialect,
): CompiledSemanticQuery {
    const metric = registry.getMetric(selection.metric);
    if (!metric) throw new Error(`Unknown metric: ${selection.metric}`);
    const base = requiredModel(registry, metric.model);
    const quote = dialect === 'postgres' ? quotePostgresIdentifier : quoteMysqlIdentifier;
    const dimensions = selection.dimensions ?? [];
    const selectedModels = new Set([base.name]);
    const joins: string[] = [];
    const joinedModels = new Set([base.name]);

    const dimensionSql = dimensions.map((dimension) => {
        const model = requiredModel(registry, dimension.model);
        const column = requiredColumn(model, dimension.column);
        if (!joinedModels.has(model.name)) {
            const path = registry.findJoinPath(base.name, model.name);
            for (const step of path.steps) {
                if (joinedModels.has(step.toModel)) continue;
                const next = requiredModel(registry, step.toModel);
                const keys = step.relationship.joinKeys.map((key) => {
                    const currentColumn = step.reversed ? key.toColumn : key.fromColumn;
                    const nextColumn = step.reversed ? key.fromColumn : key.toColumn;
                    return `${qualified(step.fromModel, currentColumn, quote)} = ` +
                        qualified(step.toModel, nextColumn, quote);
                });
                joins.push(
                    `JOIN ${quote(next.table, 'table')} AS ${quote(next.name, 'model')} ON ${keys.join(' AND ')}`,
                );
                joinedModels.add(next.name);
                selectedModels.add(next.name);
            }
        }
        return qualified(model.name, physicalColumn(column), quote);
    });

    const metricSql = compileAggregate(metric, base, quote);
    const metricAlias = quote(metric.name, 'metric');
    const select = [
        ...dimensionSql.map((sql, index) =>
            `${sql} AS ${quote(`${dimensions[index].model}_${dimensions[index].column}`, 'dimension alias')}`),
        `${metricSql} AS ${metricAlias}`,
    ];
    const appliedLimit = resolveLimit(selection.limit);
    const groupBy = dimensionSql.length ? ` GROUP BY ${dimensionSql.join(', ')}` : '';
    const orderBy = dimensionSql.length ? ` ORDER BY ${dimensionSql.join(', ')}` : '';
    const sql =
        `SELECT ${select.join(', ')} FROM ${quote(base.table, 'table')} AS ${quote(base.name, 'model')}` +
        `${joins.length ? ` ${joins.join(' ')}` : ''}${groupBy}${orderBy} LIMIT ${appliedLimit}`;

    return {
        sql,
        metric,
        models: [...selectedModels].sort(),
        appliedLimit,
    };
}

export function compileMetric(
    registry: SemanticRegistry,
    metric: string,
    dialect: Dialect,
): CompiledSemanticQuery {
    return compileSelection(registry, { metric }, dialect);
}

type Quote = (value: unknown, kind?: string) => string;

function compileAggregate(metric: Metric, model: Model, quote: Quote): string {
    const match = AGGREGATE.exec(metric.expression);
    if (!match) {
        throw new Error(`Metric "${metric.name}" has an unsupported aggregate expression: ${metric.expression}`);
    }
    const [, operation, distinct = '', operand] = match;
    const compiledOperand = operand === '*'
        ? '*'
        : qualified(model.name, physicalColumn(requiredColumn(model, operand)), quote);
    return `${operation.toUpperCase()}(${distinct.toUpperCase()}${compiledOperand})`;
}

function requiredModel(registry: SemanticRegistry, name: string): Model {
    const model = registry.getModel(name);
    if (!model) throw new Error(`Unknown model: ${name}`);
    return model;
}

function requiredColumn(model: Model, name: string): Column {
    const column = model.columns.find((candidate) => candidate.name === name);
    if (!column) throw new Error(`Unknown column: ${model.name}.${name}`);
    return column;
}

function physicalColumn(column: Column): string {
    return column.sourceColumn ?? column.name;
}

function qualified(model: string, column: string, quote: Quote): string {
    return `${quote(model, 'model')}.${quote(column, 'column')}`;
}

function resolveLimit(limit = DEFAULT_LIMIT): number {
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error(`Semantic query limit must be a positive integer, got ${limit}.`);
    }
    return Math.min(limit, MAX_LIMIT);
}
