/** Offline mining of checked-in SQL artifacts (spec R3.10). */

import { readFile } from 'node:fs/promises';
import sqlParser from 'node-sql-parser';
import type { Dialect } from '../governance/parse.js';
import type { Provenance } from './types.js';

const { Parser } = sqlParser;

export interface ArtifactCandidateBase {
    provenance: Extract<Provenance, 'query_log'>;
    verified: false;
    frequency: number;
}

export interface ArtifactRelationshipCandidate extends ArtifactCandidateBase {
    name: string;
    fromModel: string;
    toModel: string;
    joinKeys: Array<{ fromColumn: string; toColumn: string }>;
}

export interface ArtifactRuleCandidate extends ArtifactCandidateBase {
    name: string;
    expression: string;
}

export interface ArtifactMetricCandidate extends ArtifactCandidateBase {
    name: string;
    model: string;
    description: string;
    expression: string;
}

export interface ArtifactWarning {
    line: number;
    message: string;
}

export interface ArtifactMiningResult {
    relationships: ArtifactRelationshipCandidate[];
    rules: ArtifactRuleCandidate[];
    metrics: ArtifactMetricCandidate[];
    warnings: ArtifactWarning[];
}

export interface ArtifactMiningOptions {
    dialect: Dialect;
    minimumFrequency?: number;
}

interface Counted<T> {
    value: T;
    frequency: number;
}

export async function mineQueryLog(
    path: string,
    options: ArtifactMiningOptions,
): Promise<ArtifactMiningResult> {
    return mineQueryLogText(await readFile(path, 'utf8'), options);
}

export function mineQueryLogText(
    contents: string,
    options: ArtifactMiningOptions,
): ArtifactMiningResult {
    const minimum = options.minimumFrequency ?? 2;
    if (!Number.isInteger(minimum) || minimum < 2) {
        throw new RangeError(`minimumFrequency must be an integer of at least 2, got ${minimum}.`);
    }

    const relationships = new Map<string, Counted<Omit<ArtifactRelationshipCandidate, keyof ArtifactCandidateBase>>>();
    const rules = new Map<string, Counted<Omit<ArtifactRuleCandidate, keyof ArtifactCandidateBase>>>();
    const metrics = new Map<string, Counted<Omit<ArtifactMetricCandidate, keyof ArtifactCandidateBase>>>();
    const warnings: ArtifactWarning[] = [];
    const parser = new Parser();
    const database = options.dialect === 'postgres' ? 'postgresql' : 'mysql';

    for (const [index, raw] of contents.split(/\r?\n/).entries()) {
        const sql = raw.trim();
        if (!sql || sql.startsWith('#')) continue;
        let statement: Ast;
        try {
            const parsed = parser.astify(sql, { database });
            const statements = Array.isArray(parsed) ? parsed : [parsed];
            if (statements.length !== 1) {
                throw new Error('multiple statements are not a query-log entry');
            }
            if (!isAst(statements[0]) || statements[0].type !== 'select') {
                throw new Error('only SELECT artifacts are mined');
            }
            statement = statements[0];
        } catch (error) {
            warnings.push({ line: index + 1, message: (error as Error).message });
            continue;
        }

        const from = arrayOfAst(statement.from);
        const aliases = new Map<string, string>();
        for (const item of from) {
            const table = stringValue(item.table);
            if (!table) continue;
            aliases.set(stringValue(item.as) ?? table, table);
        }
        collectRelationships(from, aliases, relationships);
        collectMetrics(statement, from, aliases, metrics);

        const where = extractWhere(sql);
        if (where) {
            const key = normalizeSql(where);
            increment(rules, key, {
                name: `rule_${stableName(key)}`,
                expression: where,
            });
        }
    }

    return {
        relationships: ranked(relationships, minimum),
        rules: ranked(rules, minimum),
        metrics: ranked(metrics, minimum),
        warnings,
    };
}

type Ast = Record<string, unknown>;

function collectRelationships(
    from: Ast[],
    aliases: Map<string, string>,
    output: Map<string, Counted<Omit<ArtifactRelationshipCandidate, keyof ArtifactCandidateBase>>>,
): void {
    for (const item of from) {
        const on = isAst(item.on) ? item.on : undefined;
        if (!on || on.operator !== '=' || !isAst(on.left) || !isAst(on.right)) continue;
        const left = columnReference(on.left, aliases);
        const right = columnReference(on.right, aliases);
        if (!left || !right || left.table === right.table) continue;
        const ordered = [`${left.table}.${left.column}`, `${right.table}.${right.column}`].sort();
        const [first, second] = ordered.map(splitQualified);
        const key = `${ordered[0]}=${ordered[1]}`;
        increment(output, key, {
            name: `${first.table}_${second.table}_${first.column}_${second.column}`,
            fromModel: first.table,
            toModel: second.table,
            joinKeys: [{ fromColumn: first.column, toColumn: second.column }],
        });
    }
}

function collectMetrics(
    statement: Ast,
    from: Ast[],
    aliases: Map<string, string>,
    output: Map<string, Counted<Omit<ArtifactMetricCandidate, keyof ArtifactCandidateBase>>>,
): void {
    const baseModel = stringValue(from[0]?.table);
    if (!baseModel) return;
    for (const selected of arrayOfAst(statement.columns)) {
        const expression = isAst(selected.expr) ? selected.expr : undefined;
        if (!expression || expression.type !== 'aggr_func') continue;
        const operation = stringValue(expression.name)?.toUpperCase();
        const argument = isAst(expression.args) && isAst(expression.args.expr)
            ? expression.args.expr
            : undefined;
        if (!operation || !argument) continue;
        const reference = columnReference(argument, aliases);
        const operand = argument.type === 'star' ? '*' : reference?.column;
        if (!operand) continue;
        const model = reference?.table ?? baseModel;
        const metricExpression = `${operation}(${operand})`;
        const key = `${model}:${metricExpression}`.toLowerCase();
        increment(output, key, {
            name: `${operation.toLowerCase()}_${operand === '*' ? 'rows' : operand}`,
            model,
            description: `${operation.toLowerCase()} of ${operand} observed in query logs.`,
            expression: metricExpression,
        });
    }
}

function columnReference(value: Ast, aliases: Map<string, string>) {
    if (value.type !== 'column_ref') return undefined;
    const alias = stringValue(value.table);
    const columnNode = isAst(value.column) && isAst(value.column.expr) ? value.column.expr : undefined;
    const column = columnNode ? stringValue(columnNode.value) : undefined;
    if (!alias || !column) return undefined;
    return { table: aliases.get(alias) ?? alias, column };
}

function extractWhere(sql: string): string | undefined {
    const match = /\bWHERE\b([\s\S]*?)(?=\bGROUP\s+BY\b|\bHAVING\b|\bORDER\s+BY\b|\bLIMIT\b|;?$)/i.exec(sql);
    return match?.[1].trim().replace(/;$/, '').trim() || undefined;
}

function increment<T>(map: Map<string, Counted<T>>, key: string, value: T): void {
    const existing = map.get(key);
    if (existing) existing.frequency += 1;
    else map.set(key, { value, frequency: 1 });
}

function ranked<T>(map: Map<string, Counted<T>>, minimum: number): Array<T & ArtifactCandidateBase> {
    return [...map.entries()]
        .filter(([, item]) => item.frequency >= minimum)
        .sort(([leftKey, left], [rightKey, right]) =>
            right.frequency - left.frequency || leftKey.localeCompare(rightKey))
        .map(([, item]) => ({
            ...item.value,
            frequency: item.frequency,
            provenance: 'query_log' as const,
            verified: false as const,
        }));
}

function normalizeSql(value: string): string {
    return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function stableName(value: string): string {
    return value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48) || 'filter';
}

function splitQualified(value: string): { table: string; column: string } {
    const separator = value.indexOf('.');
    return { table: value.slice(0, separator), column: value.slice(separator + 1) };
}

function isAst(value: unknown): value is Ast {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function arrayOfAst(value: unknown): Ast[] {
    return Array.isArray(value) ? value.filter(isAst) : [];
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
