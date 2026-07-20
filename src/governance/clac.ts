/** Column visibility enforcement over semantic models and parsed SQL ASTs. */

import { policyDenied } from './errors.js';
import type { Dialect, Statement } from './parse.js';
import type { ResolvedPolicy } from './policy.js';
import type { SemanticRegistry } from '../semantic/registry.js';
import type { Column, Model } from '../semantic/types.js';

type AstNode = Record<string, unknown>;

interface ModelBinding {
    readonly qualifier: string;
    readonly model: Model;
    readonly hidden: ReadonlySet<string>;
    readonly policyNames: readonly string[];
    readonly policyNamesByColumn: ReadonlyMap<string, readonly string[]>;
    readonly expandStars: boolean;
}

export interface ColumnPolicyApplication {
    readonly appliedPolicies: readonly string[];
}

/** Returns a detached model whose hidden columns cannot be serialized. */
export function visibleModel(model: Model, policy?: ResolvedPolicy): Model {
    if (!policy) return model;
    if (policy.hiddenColumns.has('*')) throw policyDenied('clac');
    const hidden = hiddenColumnNames(model, policy);
    return {
        ...model,
        columns: model.columns.filter((column) => !hidden.has(column.name)),
    };
}

/** Semantic and physical names hidden for one model. */
export function hiddenColumnNames(model: Model, policy?: ResolvedPolicy): ReadonlySet<string> {
    if (!policy) return new Set();
    const names = new Set<string>();
    for (const column of model.columns) {
        if (policy.hiddenColumns.has(`${model.name}.${column.name}`)) {
            names.add(column.name);
            names.add(column.sourceColumn ?? column.name);
        }
    }
    return names;
}

/**
 * Rejects explicit hidden-column references and expands SELECT stars to an
 * allowlist. It mutates only the already-parsed AST supplied by governance.
 */
export function applyColumnPolicies(
    statement: Statement,
    dialect: Dialect,
    policy: ResolvedPolicy | undefined,
    semantic: SemanticRegistry | undefined,
): ColumnPolicyApplication {
    if (!policy || policy.hiddenColumns.size === 0) {
        return Object.freeze({ appliedPolicies: Object.freeze([]) });
    }
    // RLAC compiles deny decisions to `WHERE 1 = 0`; no result row can expose
    // a column value, and keeping that path executable preserves audit detail.
    if (policy.decision === 'deny') {
        return Object.freeze({ appliedPolicies: Object.freeze([]) });
    }
    if (!semantic) throw policyDenied('clac', 'Column policy could not be safely resolved.');

    const applied = new Set<string>();
    visitSelect(statement, new Map(), dialect, policy, semantic, applied, new WeakSet());
    return Object.freeze({ appliedPolicies: Object.freeze([...applied].sort()) });
}

function visitSelect(
    statement: Statement,
    inherited: ReadonlyMap<string, ModelBinding>,
    dialect: Dialect,
    policy: ResolvedPolicy,
    semantic: SemanticRegistry,
    applied: Set<string>,
    visited: WeakSet<object>,
): void {
    if (visited.has(statement)) return;
    visited.add(statement);

    const bindings = new Map(inherited);
    const localBindings = new Map<string, ModelBinding>();
    const cteModels = cteModelMap(statement.with, semantic);
    for (const value of Array.isArray(statement.from) ? statement.from : []) {
        if (!isObject(value)) continue;
        const table = identifierValue(value.table);
        if (!table) continue;
        const cteModel = cteModels.get(normalize(table));
        const model = cteModel ?? semantic.document.models.find((candidate) =>
            sameName(candidate.table, table) || sameName(candidate.name, table));
        if (!model) continue;
        const hidden = hiddenColumnNames(model, policy);
        const qualifier = identifierValue(value.as) ?? table;
        const policyNamesByColumn = hiddenPoliciesByColumn(model, policy);
        const policyNames = [...new Set([...policyNamesByColumn.values()].flatMap((names) =>
            [...names]))].sort();
        const binding = {
            qualifier,
            model,
            hidden,
            policyNames,
            policyNamesByColumn,
            expandStars: !cteModel,
        };
        localBindings.set(normalize(qualifier), binding);
        if (hidden.size === 0) continue;
        bindings.set(normalize(qualifier), binding);
        bindings.set(normalize(table), binding);
        for (const name of policyNames) applied.add(name);
    }

    rejectHiddenReferences(statement, bindings);
    expandStars(statement, localBindings, dialect);

    for (const [key, value] of Object.entries(statement)) {
        if (key !== '_next') {
            visitNested(
                value,
                key === 'with' ? inherited : bindings,
                dialect,
                policy,
                semantic,
                applied,
                visited,
            );
        }
    }
    visitNested(statement._next, inherited, dialect, policy, semantic, applied, visited);
}

function visitNested(
    value: unknown,
    inherited: ReadonlyMap<string, ModelBinding>,
    dialect: Dialect,
    policy: ResolvedPolicy,
    semantic: SemanticRegistry,
    applied: Set<string>,
    visited: WeakSet<object>,
): void {
    if (Array.isArray(value)) {
        for (const item of value) {
            visitNested(item, inherited, dialect, policy, semantic, applied, visited);
        }
        return;
    }
    if (!isObject(value) || visited.has(value)) return;
    if (nodeType(value) === 'select') {
        visitSelect(value as Statement, inherited, dialect, policy, semantic, applied, visited);
        return;
    }
    visited.add(value);
    for (const nested of Object.values(value)) {
        visitNested(nested, inherited, dialect, policy, semantic, applied, visited);
    }
}

function rejectHiddenReferences(
    statement: Statement,
    bindings: ReadonlyMap<string, ModelBinding>,
): void {
    const visited = new WeakSet<object>();
    const inspect = (value: unknown): void => {
        if (Array.isArray(value)) {
            for (const item of value) inspect(item);
            return;
        }
        if (!isObject(value) || visited.has(value)) return;
        visited.add(value);
        if (value !== statement && nodeType(value) === 'select') return;
        if (nodeType(value) === 'column_ref') {
            const column = identifierValue(value.column);
            const policy = column && column !== '*'
                ? hiddenPolicyForReference(value.table, column, bindings)
                : undefined;
            if (policy) {
                throw policyDenied(policy);
            }
        }
        for (const nested of Object.values(value)) inspect(nested);
    };
    for (const [key, value] of Object.entries(statement)) {
        if (key !== '_next') inspect(value);
    }
}

function hiddenPolicyForReference(
    tableValue: unknown,
    column: string,
    bindings: ReadonlyMap<string, ModelBinding>,
): string | undefined {
    const table = identifierValue(tableValue);
    if (table) {
        const binding = bindings.get(normalize(table));
        return binding?.hidden.has(column) ? policyForColumn(binding, column) : undefined;
    }
    const binding = [...new Set(bindings.values())].find((candidate) =>
        candidate.hidden.has(column));
    return binding ? policyForColumn(binding, column) : undefined;
}

function policyForColumn(binding: ModelBinding, column: string): string {
    const modelColumn = binding.model.columns.find((candidate) =>
        sameName(candidate.name, column) ||
        Boolean(candidate.sourceColumn && sameName(candidate.sourceColumn, column)));
    return modelColumn
        ? binding.policyNamesByColumn.get(normalize(modelColumn.name))?.[0] ?? 'clac'
        : 'clac';
}

function expandStars(
    statement: Statement,
    bindings: ReadonlyMap<string, ModelBinding>,
    dialect: Dialect,
): void {
    if (!Array.isArray(statement.columns)) return;
    const uniqueBindings = [...new Map(
        [...bindings.values()].map((binding) => [binding.qualifier, binding]),
    ).values()];

    statement.columns = statement.columns.flatMap((selection) => {
        if (!isObject(selection) || !isObject(selection.expr)) return [selection];
        const expression = selection.expr;
        if (nodeType(expression) !== 'column_ref' || identifierValue(expression.column) !== '*') {
            return [selection];
        }
        const qualifier = identifierValue(expression.table);
        if (!qualifier && !uniqueBindings.some((binding) => binding.hidden.size > 0)) {
            return [selection];
        }
        const selected = qualifier
            ? uniqueBindings.filter((binding) => sameName(binding.qualifier, qualifier))
            : [];
        if (!qualifier) {
            return (Array.isArray(statement.from) ? statement.from : []).flatMap((source) => {
                if (!isObject(source)) return [];
                const sourceQualifier = identifierValue(source.as) ?? identifierValue(source.table);
                if (!sourceQualifier) return [];
                const binding = bindings.get(normalize(sourceQualifier));
                return binding?.expandStars
                    ? visibleColumns(binding).map((column) => ({
                        expr: columnReference(
                            binding.qualifier,
                            column.sourceColumn ?? column.name,
                            dialect,
                        ),
                        as: column.sourceColumn && column.sourceColumn !== column.name
                            ? column.name
                            : null,
                    }))
                    : [{ expr: starReference(sourceQualifier), as: null }];
            });
        }
        if (
            selected.length === 0 ||
            (qualifier && (selected[0].hidden.size === 0 || !selected[0].expandStars))
        ) {
            return [selection];
        }
        return selected.flatMap((binding) => visibleColumns(binding).map((column) => ({
            expr: columnReference(binding.qualifier, column.sourceColumn ?? column.name, dialect),
            as: column.sourceColumn && column.sourceColumn !== column.name ? column.name : null,
        })));
    });
}

function visibleColumns(binding: ModelBinding): Column[] {
    return binding.model.columns.filter((column) => !binding.hidden.has(column.name));
}

function hiddenPoliciesByColumn(
    model: Model,
    policy: ResolvedPolicy,
): ReadonlyMap<string, readonly string[]> {
    return new Map(model.columns.flatMap((column) => {
        const names = policy.hiddenColumnPolicies[`${model.name}.${column.name}`];
        return names?.length ? [[normalize(column.name), names] as const] : [];
    }));
}

function cteModelMap(value: unknown, semantic: SemanticRegistry): Map<string, Model> {
    const result = new Map<string, Model>();
    if (!Array.isArray(value)) return result;
    for (const clause of value) {
        if (!isObject(clause)) continue;
        const name = identifierValue(clause.name);
        const select = unwrapSelect(clause.stmt);
        const from = select && Array.isArray(select.from) ? select.from : [];
        if (!name || from.length !== 1 || !isObject(from[0])) continue;
        const table = identifierValue(from[0].table);
        if (!table) continue;
        const model = semantic.document.models.find((candidate) =>
            sameName(candidate.table, table) || sameName(candidate.name, table));
        if (model) result.set(normalize(name), model);
    }
    return result;
}

function unwrapSelect(value: unknown): Statement | undefined {
    if (!isObject(value)) return undefined;
    if (nodeType(value) === 'select') return value as Statement;
    return unwrapSelect(value.ast);
}

function columnReference(table: string, column: string, dialect: Dialect): AstNode {
    return {
        type: 'column_ref',
        table,
        column: dialect === 'postgres'
            ? { expr: { type: 'default', value: column } }
            : column,
        collate: null,
    };
}

function starReference(table: string): AstNode {
    return { type: 'column_ref', table, column: '*' };
}

function identifierValue(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (!isObject(value)) return undefined;
    if (typeof value.value === 'string') return value.value;
    return identifierValue(value.expr);
}

function sameName(left: string, right: string): boolean {
    return normalize(left) === normalize(right);
}

function normalize(value: string): string {
    return value.toLocaleLowerCase();
}

function nodeType(value: AstNode): string {
    return typeof value.type === 'string' ? value.type.toLocaleLowerCase() : '';
}

function isObject(value: unknown): value is AstNode {
    return typeof value === 'object' && value !== null;
}
