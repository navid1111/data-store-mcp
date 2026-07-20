import { describe, expect, it } from 'vitest';
import {
  PolicyEngine,
  type PolicyDocument,
  type PolicyScalar,
} from '../../src/governance/policy.js';
import { parsePrincipal } from '../../src/auth/principal.js';

describe('principal policy engine', () => {
  it('resolves row predicates and hidden columns for a principal', () => {
    const resolved = new PolicyEngine(fixture()).resolve(
      parsePrincipal('store-analyst', 'test'),
    );

    expect(resolved.decision).toBe('allow');
    expect(resolved.roles).toEqual(['store-one']);
    expect(resolved.rowPredicates.customer).toEqual([
      expect.objectContaining({
        qualifiedName: 'store-one:customer-store',
        model: 'customer',
        column: 'store_id',
        operator: 'eq',
        value: 1,
        combineWith: 'and',
      }),
    ]);
    expect([...resolved.hiddenColumns]).toEqual(['customer.email']);
    expect(resolved.appliedPolicies).toEqual([
      'store-one:customer-contact',
      'store-one:customer-store',
    ]);
  });

  it('composes multiple roles conservatively and deterministically', () => {
    const resolved = new PolicyEngine(fixture()).resolve('regional-store-analyst');

    expect(resolved.roles).toEqual(['east-region', 'store-one']);
    expect(resolved.rowPredicates.customer.map((rule) => rule.qualifiedName)).toEqual([
      'east-region:customer-region',
      'store-one:customer-store',
    ]);
    expect(resolved.rowPredicates.customer.every((rule) => rule.combineWith === 'and')).toBe(true);
    expect([...resolved.hiddenColumns]).toEqual([
      'customer.email',
      'customer.last_name',
      'payment.amount',
    ]);
    expect(resolved.appliedPolicies).toEqual([
      'east-region:customer-names',
      'east-region:customer-region',
      'east-region:payment-values',
      'store-one:customer-contact',
      'store-one:customer-store',
    ]);
  });

  it('returns an explicit deny-all policy for an unknown principal', () => {
    const resolved = new PolicyEngine(fixture()).resolve('not-configured');

    expect(resolved).toEqual(expect.objectContaining({
      decision: 'deny',
      reason: 'unknown-principal',
      roles: [],
      appliedPolicies: ['deny:unknown-principal'],
    }));
    expect(resolved.rowPredicates['*']).toEqual([
      expect.objectContaining({ operator: 'deny', model: '*', column: '*' }),
    ]);
    expect([...resolved.hiddenColumns]).toEqual(['*']);
  });

  it('does not mutate inputs or share mutable resolution state', () => {
    const input = deepFreeze(fixture());
    const engine = new PolicyEngine(input);
    const first = engine.resolve('regional-store-analyst');

    expect(() => (first.roles as string[]).push('admin')).toThrow();
    expect(() => (first.rowPredicates.customer as unknown[]).splice(0)).toThrow();
    const membership = first.rowPredicates.customer[0];
    expect(membership.operator).toBe('in');
    if (membership.operator === 'in') {
      expect(() => (membership.values as PolicyScalar[]).push('South')).toThrow();
    }
    expect((first.hiddenColumns as Set<string>).add).toBeUndefined();

    const second = engine.resolve('regional-store-analyst');
    expect(second).toEqual(first);
    expect([...second.hiddenColumns]).toEqual([...first.hiddenColumns]);
  });

  it('rejects assignments to undefined roles', () => {
    const invalid = fixture();
    invalid.principals['store-analyst'].roles.push('missing-role');
    expect(() => new PolicyEngine(invalid)).toThrow(
      'Principal "store-analyst" references unknown role "missing-role"',
    );
  });
});

function fixture(): PolicyDocument {
  return {
    roles: {
      'store-one': {
        rowFilters: [{
          name: 'customer-store',
          model: 'customer',
          column: 'store_id',
          operator: 'eq',
          value: 1,
        }],
        hiddenColumns: [{
          name: 'customer-contact',
          model: 'customer',
          columns: ['email'],
        }],
      },
      'east-region': {
        rowFilters: [{
          name: 'customer-region',
          model: 'customer',
          column: 'district',
          operator: 'in',
          values: ['East', 'North-East'],
        }],
        hiddenColumns: [
          {
            name: 'customer-names',
            model: 'customer',
            columns: ['last_name'],
          },
          {
            name: 'payment-values',
            model: 'payment',
            columns: ['amount'],
          },
        ],
      },
    },
    principals: {
      'store-analyst': { roles: ['store-one'] },
      'regional-store-analyst': { roles: ['store-one', 'east-region', 'store-one'] },
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
