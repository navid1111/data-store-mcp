import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan } from '../../src/governance/gate.js';
import { PolicyEngine } from '../../src/governance/policy.js';
import { visibleModel } from '../../src/governance/clac.js';
import { SemanticRegistry } from '../../src/semantic/registry.js';

let directory: string;
let semantic: SemanticRegistry;

const policy = new PolicyEngine({
  roles: {
    analyst: {
      hiddenColumns: [{
        name: 'film-cost',
        model: 'film',
        columns: ['replacement_cost'],
      }, {
        name: 'film-note',
        model: 'film',
        columns: ['internal_note'],
      }],
    },
  },
  principals: { user: { roles: ['analyst'] } },
}).resolve('user');

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'data-store-mcp-clac-'));
  await writeFile(join(directory, 'film.yml'), `models:
  - name: film
    description: Films.
    provenance: human
    source: fixture
    table: film
    columns:
      - name: film_id
        description: Identifier.
        provenance: human
        dataType: integer
      - name: title
        description: Title.
        provenance: human
        dataType: text
      - name: replacement_cost
        description: Internal cost.
        provenance: human
        dataType: numeric
      - name: internal_note
        description: Internal note.
        provenance: human
        dataType: text
`);
  semantic = await SemanticRegistry.load(directory);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe.each(['postgres', 'mysql'] as const)('CLAC AST enforcement / %s', (dialect) => {
  it('expands SELECT star to declared visible columns', () => {
    const plan = buildPlan('SELECT * FROM film', { dialect, policy, semantic });

    expect(plan.sql).toMatch(/film_id/i);
    expect(plan.sql).toMatch(/title/i);
    expect(plan.sql).not.toMatch(/replacement_cost/i);
    expect(plan.sql).not.toMatch(/internal_note/i);
    expect(plan.appliedPolicies).toContain('analyst:film-cost');
    expect(plan.appliedPolicies).toContain('analyst:film-note');
  });

  it('denies direct, aliased, and CTE-aliased hidden references generically', () => {
    for (const [sql, policyName] of [
      ['SELECT replacement_cost FROM film', 'analyst:film-cost'],
      ['SELECT f.replacement_cost FROM film f', 'analyst:film-cost'],
      [
        'WITH visible AS (SELECT * FROM film) SELECT replacement_cost FROM visible',
        'analyst:film-cost',
      ],
      ['SELECT internal_note FROM film', 'analyst:film-note'],
    ]) {
      try {
        buildPlan(sql, { dialect, policy, semantic });
        throw new Error('Expected CLAC denial');
      } catch (error) {
        expect(error).toEqual(expect.objectContaining({
          detail: expect.objectContaining({
            code: 'E_POLICY_DENIED',
            policy: policyName,
          }),
        }));
        expect((error as Error).message).not.toContain('replacement_cost');
        expect((error as Error).message).not.toContain('internal_note');
      }
    }
  });
});

it('omits hidden columns from serializable model metadata', () => {
  const model = semantic.getModel('film')!;
  expect(visibleModel(model, policy).columns.map((column) => column.name)).toEqual([
    'film_id',
    'title',
  ]);
});
