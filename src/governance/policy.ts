/** Pure principal -> RLAC/CLAC policy resolution (spec R8.3/R8.4). */

import { z } from 'zod';
import type { Principal } from '../auth/principal.js';

const policyName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]*$/);
const semanticName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]*$/);
const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

const comparisonRuleSchema = z.object({
    name: policyName,
    model: semanticName,
    column: semanticName,
    operator: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte']),
    value: scalar,
}).strict();

const membershipRuleSchema = z.object({
    name: policyName,
    model: semanticName,
    column: semanticName,
    operator: z.literal('in'),
    values: z.array(scalar).min(1),
}).strict();

const rowRuleSchema = z.discriminatedUnion('operator', [
    comparisonRuleSchema,
    membershipRuleSchema,
]);

const columnRuleSchema = z.object({
    name: policyName,
    model: semanticName,
    columns: z.array(semanticName).min(1),
}).strict();

const roleSchema = z.object({
    rowFilters: z.array(rowRuleSchema).default([]),
    hiddenColumns: z.array(columnRuleSchema).default([]),
}).strict();

const principalSchema = z.object({
    roles: z.array(policyName).min(1),
}).strict();

const policyDocumentSchema = z.object({
    roles: z.record(policyName, roleSchema),
    principals: z.record(z.string().trim().min(1), principalSchema),
}).strict();

export type PolicyScalar = z.infer<typeof scalar>;
type ComparisonRowPolicyRule = z.infer<typeof comparisonRuleSchema>;
type MembershipRowPolicyRule = z.infer<typeof membershipRuleSchema>;
export type RowPolicyRule = ComparisonRowPolicyRule | MembershipRowPolicyRule;
export type HiddenColumnRule = z.infer<typeof columnRuleSchema>;
export type RolePolicy = z.infer<typeof roleSchema>;
export type PolicyDocument = z.input<typeof policyDocumentSchema>;

type FrozenRowPolicyRule =
    | Readonly<ComparisonRowPolicyRule>
    | (Readonly<Omit<MembershipRowPolicyRule, 'values'>> & {
        readonly values: readonly PolicyScalar[];
    });

export type ResolvedRowPredicate =
    | (FrozenRowPolicyRule & {
        readonly role: string;
        readonly qualifiedName: string;
        readonly combineWith: 'and';
    })
    | {
        readonly name: 'deny-all';
        readonly qualifiedName: 'deny:unknown-principal';
        readonly role: '*';
        readonly model: '*';
        readonly column: '*';
        readonly operator: 'deny';
        readonly combineWith: 'and';
    };

export interface ResolvedPolicy {
    principal: string;
    decision: 'allow' | 'deny';
    reason?: 'unknown-principal';
    roles: readonly string[];
    /** Model name -> predicates, combined with logical AND. `*` is deny-all. */
    rowPredicates: Readonly<Record<string, readonly ResolvedRowPredicate[]>>;
    /** Qualified `model.column` names; `*` means every column is hidden. */
    hiddenColumns: ReadonlySet<string>;
    appliedPolicies: readonly string[];
}

interface CompiledDocument {
    roles: Readonly<Record<string, {
        readonly rowFilters: readonly FrozenRowPolicyRule[];
        readonly hiddenColumns: readonly (Readonly<Omit<HiddenColumnRule, 'columns'>> & {
            readonly columns: readonly string[];
        })[];
    }>>;
    principals: Readonly<Record<string, { readonly roles: readonly string[] }>>;
}

export class PolicyEngine {
    private readonly document: CompiledDocument;

    constructor(input: PolicyDocument) {
        const parsed = policyDocumentSchema.parse(input);
        assertReferencedRolesExist(parsed);
        this.document = compileDocument(parsed);
    }

    /** Pure and deterministic: returns a fresh immutable decision on every call. */
    resolve(principal: Principal | string): ResolvedPolicy {
        const assignment = this.document.principals[String(principal)];
        if (!assignment) return denyUnknownPrincipal(String(principal));

        const roles = [...new Set(assignment.roles)].sort((left, right) =>
            left.localeCompare(right));
        const byModel = new Map<string, ResolvedRowPredicate[]>();
        const hiddenColumns: string[] = [];
        const appliedPolicies = new Set<string>();

        for (const roleName of roles) {
            const role = this.document.roles[roleName];
            for (const rule of role.rowFilters) {
                const qualifiedName = `${roleName}:${rule.name}`;
                const resolved = Object.freeze({
                    ...cloneRowRule(rule),
                    role: roleName,
                    qualifiedName,
                    combineWith: 'and' as const,
                });
                const predicates = byModel.get(rule.model) ?? [];
                predicates.push(resolved);
                byModel.set(rule.model, predicates);
                appliedPolicies.add(qualifiedName);
            }
            for (const rule of role.hiddenColumns) {
                const qualifiedName = `${roleName}:${rule.name}`;
                for (const column of rule.columns) {
                    hiddenColumns.push(`${rule.model}.${column}`);
                }
                appliedPolicies.add(qualifiedName);
            }
        }

        const rowPredicates = Object.freeze(Object.fromEntries(
            [...byModel.entries()]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([model, predicates]) => [
                    model,
                    Object.freeze(predicates.sort(comparePredicates)),
                ]),
        ));
        return Object.freeze({
            principal: String(principal),
            decision: 'allow' as const,
            roles: Object.freeze(roles),
            rowPredicates,
            hiddenColumns: new FrozenStringSet(hiddenColumns),
            appliedPolicies: Object.freeze([...appliedPolicies].sort()),
        });
    }
}

function assertReferencedRolesExist(
    document: z.output<typeof policyDocumentSchema>,
): void {
    for (const [principal, assignment] of Object.entries(document.principals)) {
        for (const role of assignment.roles) {
            if (!Object.hasOwn(document.roles, role)) {
                throw new Error(`Principal "${principal}" references unknown role "${role}".`);
            }
        }
    }
}

function compileDocument(
    document: z.output<typeof policyDocumentSchema>,
): CompiledDocument {
    return Object.freeze({
        roles: Object.freeze(Object.fromEntries(Object.entries(document.roles).map(([name, role]) => [
            name,
            Object.freeze({
                rowFilters: Object.freeze(role.rowFilters.map((rule) =>
                    cloneRowRule(rule))),
                hiddenColumns: Object.freeze(role.hiddenColumns.map((rule) => Object.freeze({
                    ...rule,
                    columns: Object.freeze([...rule.columns]),
                }))),
            }),
        ]))),
        principals: Object.freeze(Object.fromEntries(
            Object.entries(document.principals).map(([name, assignment]) => [
                name,
                Object.freeze({ roles: Object.freeze([...assignment.roles]) }),
            ]),
        )),
    });
}

function cloneRowRule(rule: RowPolicyRule | FrozenRowPolicyRule): FrozenRowPolicyRule {
    return rule.operator === 'in'
        ? Object.freeze({ ...rule, values: Object.freeze([...rule.values]) })
        : Object.freeze({ ...rule });
}

function comparePredicates(left: ResolvedRowPredicate, right: ResolvedRowPredicate): number {
    return left.qualifiedName.localeCompare(right.qualifiedName);
}

function denyUnknownPrincipal(principal: string): ResolvedPolicy {
    const predicate: ResolvedRowPredicate = Object.freeze({
        name: 'deny-all',
        qualifiedName: 'deny:unknown-principal',
        role: '*',
        model: '*',
        column: '*',
        operator: 'deny',
        combineWith: 'and',
    });
    return Object.freeze({
        principal,
        decision: 'deny' as const,
        reason: 'unknown-principal' as const,
        roles: Object.freeze([]),
        rowPredicates: Object.freeze({ '*': Object.freeze([predicate]) }),
        hiddenColumns: new FrozenStringSet(['*']),
        appliedPolicies: Object.freeze(['deny:unknown-principal']),
    });
}

/** ReadonlySet with no runtime mutation methods exposed through a cast. */
class FrozenStringSet implements ReadonlySet<string> {
    readonly #values: Set<string>;

    constructor(values: Iterable<string>) {
        this.#values = new Set([...values].sort((left, right) => left.localeCompare(right)));
        Object.freeze(this);
    }

    get size(): number {
        return this.#values.size;
    }

    has(value: string): boolean {
        return this.#values.has(value);
    }

    forEach(
        callback: (value: string, value2: string, set: ReadonlySet<string>) => void,
        thisArg?: unknown,
    ): void {
        for (const value of this.#values) callback.call(thisArg, value, value, this);
    }

    entries(): SetIterator<[string, string]> {
        return this.#values.entries();
    }

    keys(): SetIterator<string> {
        return this.#values.keys();
    }

    values(): SetIterator<string> {
        return this.#values.values();
    }

    [Symbol.iterator](): SetIterator<string> {
        return this.values();
    }
}
