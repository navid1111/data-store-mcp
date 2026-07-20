/** T4.3 — row policies survive SQL-authored bypass attempts on live engines. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database, Row } from '../../src/database-source.js';
import { buildPlan } from '../../src/governance/gate.js';
import type { Dialect } from '../../src/governance/parse.js';
import { PolicyEngine, type ResolvedPolicy } from '../../src/governance/policy.js';
import { parsePrincipal } from '../../src/auth/principal.js';
import { MysqlDatabase } from '../../src/mysql.js';
import { PostgresDatabase } from '../../src/postgres.js';
import { PAGILA, SAKILA } from '../helpers/sources.js';

interface Engine {
  label: string;
  dialect: Dialect;
  make: () => Database;
  ph: (position: number) => string;
  close: (database: Database) => Promise<void>;
}

const engines: Engine[] = [
  {
    label: 'postgres',
    dialect: 'postgres',
    make: () => new PostgresDatabase(PAGILA),
    ph: (position) => `$${position}`,
    close: async (database) => { await (database as any).pool?.end(); },
  },
  {
    label: 'mysql',
    dialect: 'mysql',
    make: () => new MysqlDatabase(SAKILA),
    ph: () => '?',
    close: async (database) => { await (database as any).connection?.end(); },
  },
];

const policies = new PolicyEngine({
  roles: {
    'store-one': {
      rowFilters: [{
        name: 'customer-store',
        model: 'customer',
        column: 'store_id',
        operator: 'eq',
        value: 1,
      }],
    },
  },
  principals: {
    analyst: { roles: ['store-one'] },
  },
});
const scopedPolicy = policies.resolve(parsePrincipal('analyst', 'test'));

describe.each(engines)('RLAC injection / $label', (engine) => {
  let database: Database;

  beforeAll(async () => {
    database = engine.make();
    await database.connect();
  }, 60_000);

  afterAll(async () => {
    await engine.close(database);
  });

  const plan = (sql: string, policy: ResolvedPolicy = scopedPolicy) => buildPlan(sql, {
    dialect: engine.dialect,
    policy,
  });

  const run = async (sql: string, policy: ResolvedPolicy = scopedPolicy) => {
    const compiled = plan(sql, policy);
    const rows = await database.execute(compiled) as Row[];
    return { compiled, rows };
  };

  const runWithParams = async (sql: string, params: readonly unknown[]) => {
    const compiled = buildPlan(sql, {
      dialect: engine.dialect,
      params,
      policy: scopedPolicy,
    });
    const rows = await database.execute(compiled) as Row[];
    return { compiled, rows };
  };

  it.each([
    'SELECT customer_id, store_id FROM customer',
    'SELECT customer_id, store_id FROM customer WHERE store_id = 2 OR 1=1',
    'SELECT customer_id, store_id FROM customer WHERE store_id = 2 OR 1=1 -- bypass',
  ])('scopes rows and exposes the injected predicate on the plan: %s', async (sql) => {
    const { compiled, rows } = await run(sql);

    expect(compiled.sql).toMatch(policyPredicatePattern());
    expect(compiled.params).toEqual([1]);
    expect(compiled.appliedPolicies).toContain('store-one:customer-store');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => Number(row.store_id) === 1)).toBe(true);
  });

  it('injects the predicate into every UNION arm', async () => {
    const { compiled, rows } = await run(`
      SELECT customer_id, store_id FROM customer WHERE customer_id < 10
      UNION ALL
      SELECT customer_id, store_id FROM customer WHERE store_id = 2
    `);

    expect(compiled.sql.match(policyPredicatePattern())?.length).toBe(2);
    expect(compiled.params).toEqual([1, 1]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => Number(row.store_id) === 1)).toBe(true);
  });

  it('qualifies policy columns for every alias in a self-join', async () => {
    const { compiled, rows } = await run(`
      SELECT first.customer_id, first.store_id
      FROM customer first
      JOIN customer second ON second.customer_id = first.customer_id
    `);

    expect(compiled.sql.match(policyPredicatePattern())?.length).toBe(2);
    expect(compiled.params).toEqual([1, 1]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => Number(row.store_id) === 1)).toBe(true);
  });

  it('injects inside CTEs and nested subqueries without governing the CTE alias', async () => {
    const { compiled, rows } = await run(`
      WITH visible_customer AS (
        SELECT customer_id, store_id FROM customer
      )
      SELECT vc.customer_id, vc.store_id
      FROM visible_customer vc
      WHERE EXISTS (
        SELECT 1 FROM customer nested
        WHERE nested.customer_id = vc.customer_id
      )
    `);

    expect(compiled.sql.match(policyPredicatePattern())?.length).toBe(2);
    expect(compiled.params).toEqual([1, 1]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => Number(row.store_id) === 1)).toBe(true);
  });

  it('preserves binding order when a CTE policy precedes an agent parameter', async () => {
    const { compiled, rows } = await runWithParams(`
      WITH visible_customer AS (
        SELECT customer_id, store_id FROM customer
      )
      SELECT customer_id, store_id FROM visible_customer
      WHERE customer_id > ${engine.ph(1)}
    `, [0]);

    expect(compiled.params).toEqual(engine.dialect === 'postgres' ? [0, 1] : [1, 0]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => Number(row.store_id) === 1)).toBe(true);
  });

  it('turns an unknown principal into an executable deny-all plan', async () => {
    const denied = policies.resolve('unknown');
    const { compiled, rows } = await run(
      'SELECT customer_id, store_id FROM customer',
      denied,
    );

    expect(compiled.sql).toMatch(/1\s*=\s*0/);
    expect(compiled.appliedPolicies).toContain('deny:unknown-principal');
    expect(rows).toEqual([]);
  });
});

function policyPredicatePattern(): RegExp {
  return /(?:["`]store_id["`]|store_id)\s*=\s*(?:\$\d+|\?)/gi;
}
