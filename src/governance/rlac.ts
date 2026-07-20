/** AST-level row policy injection. Agent-authored SQL is never concatenated. */

import type { Dialect, Statement } from './parse.js';
import { parseError } from './errors.js';
import type { ResolvedPolicy, ResolvedRowPredicate } from './policy.js';

type AstNode = Record<string, unknown>;

const SQL_OPERATOR = {
    eq: '=',
    neq: '<>',
    lt: '<',
    lte: '<=',
    gt: '>',
    gte: '>=',
} as const;

export interface RowPolicyInjection {
    readonly params: readonly unknown[];
    readonly appliedPolicies: readonly string[];
}

interface InjectionContext {
    readonly dialect: Dialect;
    readonly policy: ResolvedPolicy;
    readonly predicatesByModel: ReadonlyMap<string, readonly ResolvedRowPredicate[]>;
    readonly appliedPolicies: Set<string>;
    readonly policyBindings: WeakMap<object, unknown>;
    readonly policyValues: unknown[];
    nextPostgresParameter: number;
}

/**
 * Applies every resolved row predicate to every physical model occurrence.
 *
 * The traversal understands SELECT arms, CTE scope and nested query wrappers.
 * Existing WHERE expressions become the left side of an AND, so an agent's
 * OR, UNION or trailing comment cannot escape a policy added after parsing.
 */
export function injectRowPolicies(
    statement: Statement,
    dialect: Dialect,
    policy: ResolvedPolicy | undefined,
    inputParams: readonly unknown[] = [],
): RowPolicyInjection {
    if (!policy) {
        return Object.freeze({
            params: Object.freeze([...inputParams]),
            appliedPolicies: Object.freeze([]),
        });
    }

    const originalMysqlBindings = dialect === 'mysql'
        ? captureMysqlBindings(statement, inputParams)
        : undefined;
    const postgresParameterCount = dialect === 'postgres'
        ? validatePostgresBindings(statement, inputParams)
        : 0;
    const context: InjectionContext = {
        dialect,
        policy,
        predicatesByModel: indexPredicates(policy),
        appliedPolicies: new Set(),
        policyBindings: new WeakMap(),
        policyValues: [],
        nextPostgresParameter: postgresParameterCount,
    };

    visitSelect(statement, new Set(), context, new WeakSet());

    const params = dialect === 'mysql' && context.policyValues.length > 0
        ? mergeMysqlBindings(statement, originalMysqlBindings!, context.policyBindings)
        : [...inputParams, ...context.policyValues];

    return Object.freeze({
        params: Object.freeze(params),
        appliedPolicies: Object.freeze([...context.appliedPolicies].sort()),
    });
}

function indexPredicates(
    policy: ResolvedPolicy,
): ReadonlyMap<string, readonly ResolvedRowPredicate[]> {
    const result = new Map<string, readonly ResolvedRowPredicate[]>();
    for (const [model, predicates] of Object.entries(policy.rowPredicates)) {
        if (model !== '*') result.set(normalizeIdentifier(model), predicates);
    }
    return result;
}

function visitSelect(
    statement: Statement,
    inheritedCtes: ReadonlySet<string>,
    context: InjectionContext,
    visited: WeakSet<object>,
): void {
    if (visited.has(statement)) return;
    visited.add(statement);

    const visibleCtes = new Set(inheritedCtes);
    const withClauses = Array.isArray(statement.with) ? statement.with : [];
    for (const clause of withClauses) {
        if (!isObject(clause)) continue;
        // A non-recursive CTE may reference earlier CTEs, but not itself.
        visitNested(clause.stmt, visibleCtes, context, visited);
        const name = identifierValue(clause.name);
        if (name) visibleCtes.add(normalizeIdentifier(name));
    }

    // Nested SELECTs can occur in columns, FROM items, predicates and HAVING.
    for (const [key, value] of Object.entries(statement)) {
        if (key !== 'with' && key !== '_next') {
            visitNested(value, visibleCtes, context, visited);
        }
    }

    applyToSelectArm(statement, visibleCtes, context);
    visitNested(statement._next, visibleCtes, context, visited);
}

function visitNested(
    value: unknown,
    visibleCtes: ReadonlySet<string>,
    context: InjectionContext,
    visited: WeakSet<object>,
): void {
    if (Array.isArray(value)) {
        for (const item of value) visitNested(item, visibleCtes, context, visited);
        return;
    }
    if (!isObject(value) || visited.has(value)) return;
    if (statementType(value) === 'select') {
        visitSelect(value as Statement, visibleCtes, context, visited);
        return;
    }

    visited.add(value);
    for (const nested of Object.values(value)) {
        visitNested(nested, visibleCtes, context, visited);
    }
}

function applyToSelectArm(
    statement: Statement,
    visibleCtes: ReadonlySet<string>,
    context: InjectionContext,
): void {
    if (context.policy.decision === 'deny') {
        statement.where = and(statement.where, denyExpression());
        context.appliedPolicies.add('deny:unknown-principal');
        return;
    }

    const fromItems = Array.isArray(statement.from) ? statement.from : [];
    for (const value of fromItems) {
        if (!isObject(value)) continue;
        const table = identifierValue(value.table);
        if (!table || visibleCtes.has(normalizeIdentifier(table))) continue;

        const predicates = context.predicatesByModel.get(normalizeIdentifier(table)) ?? [];
        const qualifier = identifierValue(value.as) ?? table;
        for (const predicate of predicates) {
            if (predicate.operator === 'deny') continue;
            statement.where = and(statement.where, predicateExpression(predicate, qualifier, context));
            context.appliedPolicies.add(predicate.qualifiedName);
        }
    }
}

function predicateExpression(
    predicate: Exclude<ResolvedRowPredicate, { operator: 'deny' }>,
    qualifier: string,
    context: InjectionContext,
): AstNode {
    const left = columnReference(qualifier, predicate.column, context.dialect);
    if (predicate.operator === 'in') {
        return {
            type: 'binary_expr',
            operator: 'IN',
            left,
            right: {
                type: 'expr_list',
                value: predicate.values.map((value) => binding(value, context)),
            },
        };
    }
    return {
        type: 'binary_expr',
        operator: SQL_OPERATOR[predicate.operator],
        left,
        right: binding(predicate.value, context),
    };
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

function binding(value: unknown, context: InjectionContext): AstNode {
    context.policyValues.push(value);
    if (context.dialect === 'postgres') {
        context.nextPostgresParameter += 1;
        return {
            type: 'var',
            name: context.nextPostgresParameter,
            members: [],
            quoted: null,
            prefix: '$',
        };
    }

    const placeholder = { type: 'origin', value: '?' };
    context.policyBindings.set(placeholder, value);
    return placeholder;
}

function denyExpression(): AstNode {
    return {
        type: 'binary_expr',
        operator: '=',
        left: { type: 'number', value: 1 },
        right: { type: 'number', value: 0 },
    };
}

function and(existing: unknown, policy: AstNode): AstNode {
    if (!existing) return policy;
    return {
        type: 'binary_expr',
        operator: 'AND',
        // node-sql-parser does not infer parentheses from an AND node whose
        // left child is OR. Mark the prior tree explicitly or `OR 1=1`
        // regenerates as `original OR (1=1 AND policy)` and bypasses RLAC.
        left: isObject(existing) ? { ...existing, parentheses: true } : existing,
        right: policy,
    };
}

function captureMysqlBindings(
    statement: Statement,
    params: readonly unknown[],
): WeakMap<object, unknown> {
    const placeholders = collectNodes(statement, isMysqlPlaceholder);
    if (placeholders.length !== params.length) {
        throw parseError(
            `RLAC requires ${placeholders.length} MySQL parameter(s), but ${params.length} were supplied`,
            undefined,
            'Supply exactly one bound value for every ? placeholder.',
        );
    }
    const bindings = new WeakMap<object, unknown>();
    placeholders.forEach((placeholder, index) => bindings.set(placeholder, params[index]));
    return bindings;
}

function mergeMysqlBindings(
    statement: Statement,
    original: WeakMap<object, unknown>,
    policy: WeakMap<object, unknown>,
): unknown[] {
    return collectNodes(statement, isMysqlPlaceholder).map((placeholder) => {
        if (policy.has(placeholder)) return policy.get(placeholder);
        if (original.has(placeholder)) return original.get(placeholder);
        throw parseError('RLAC encountered an unbound MySQL placeholder after rewriting');
    });
}

function validatePostgresBindings(statement: Statement, params: readonly unknown[]): number {
    const placeholders = collectNodes(statement, isPostgresPlaceholder);
    const indexes = placeholders.map((placeholder) => Number(placeholder.name));
    const highest = indexes.length === 0 ? 0 : Math.max(...indexes);
    if (indexes.some((index) => !Number.isInteger(index) || index < 1) || highest > params.length) {
        throw parseError(
            `RLAC cannot safely append parameters after PostgreSQL placeholder $${highest}`,
            undefined,
            `Supply values through $${highest} before applying row policies.`,
        );
    }
    return Math.max(highest, params.length);
}

function collectNodes(root: unknown, predicate: (node: AstNode) => boolean): AstNode[] {
    const result: AstNode[] = [];
    const visited = new WeakSet<object>();
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
            for (const item of value) visit(item);
            return;
        }
        if (!isObject(value) || visited.has(value)) return;
        visited.add(value);
        if (predicate(value)) result.push(value);
        for (const nested of Object.values(value)) visit(nested);
    };
    visit(root);
    return result;
}

function isMysqlPlaceholder(node: AstNode): boolean {
    return node.type === 'origin' && node.value === '?';
}

function isPostgresPlaceholder(node: AstNode): boolean {
    return node.type === 'var' && node.prefix === '$';
}

function identifierValue(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (!isObject(value)) return undefined;
    if (typeof value.value === 'string') return value.value;
    return identifierValue(value.expr);
}

function normalizeIdentifier(value: string): string {
    return value.toLocaleLowerCase();
}

function statementType(value: AstNode): string {
    return typeof value.type === 'string' ? value.type.toLocaleLowerCase() : '';
}

function isObject(value: unknown): value is AstNode {
    return typeof value === 'object' && value !== null;
}
