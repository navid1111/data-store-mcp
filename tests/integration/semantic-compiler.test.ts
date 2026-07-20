import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '../../src/database-source.js';
import { buildPlan } from '../../src/governance/gate.js';
import type { Dialect } from '../../src/governance/parse.js';
import { MysqlDatabase } from '../../src/mysql.js';
import { PostgresDatabase } from '../../src/postgres.js';
import { compileMetric, compileSelection } from '../../src/semantic/compiler.js';
import { SemanticRegistry } from '../../src/semantic/registry.js';
import { EXPECTED, PAGILA, SAKILA } from '../helpers/sources.js';

interface Engine {
  dialect: Dialect;
  db: Database;
  close: () => Promise<void>;
}

let registry: SemanticRegistry;
let directory: string;
const engines: Engine[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'data-store-mcp-compiler-'));
  const path = join(directory, 'film.yml');
  await writeFile(path, `models:
  - name: film
    description: Film catalog.
    provenance: human
    verified: true
    source: fixture
    table: film
    columns:
      - name: film_id
        description: Film identifier.
        provenance: introspection
        dataType: integer
      - name: language_id
        description: Film language identifier.
        provenance: introspection
        dataType: integer
  - name: language
    description: Spoken language.
    provenance: human
    verified: true
    source: fixture
    table: language
    columns:
      - name: language_id
        description: Language identifier.
        provenance: introspection
        dataType: integer
      - name: name
        description: Language name.
        provenance: db_comment
        dataType: text
relationships:
  - name: film_language
    description: Each film has a language.
    provenance: introspection
    fromModel: film
    toModel: language
    cardinality: many-to-one
    joinKeys:
      - fromColumn: language_id
        toColumn: language_id
metrics:
  - name: film_count
    description: Number of films.
    provenance: human
    verified: true
    model: film
    expression: COUNT(film_id)
`);
  registry = await SemanticRegistry.load(directory);

  const postgres = new PostgresDatabase(PAGILA);
  const mysql = new MysqlDatabase(SAKILA);
  await Promise.all([postgres.connect(), mysql.connect()]);
  engines.push(
    { dialect: 'postgres', db: postgres, close: async () => { await (postgres as any).pool?.end(); } },
    { dialect: 'mysql', db: mysql, close: async () => { await (mysql as any).connection?.end(); } },
  );
}, 60_000);

afterAll(async () => {
  await Promise.all(engines.map((engine) => engine.close()));
  await rm(directory, { recursive: true, force: true });
});

describe('semantic compiler', () => {
  it('quotes identifiers for each target dialect', () => {
    expect(compileMetric(registry, 'film_count', 'postgres').sql).toContain(
      'COUNT("film"."film_id")',
    );
    expect(compileMetric(registry, 'film_count', 'mysql').sql).toContain(
      'COUNT(`film`.`film_id`)',
    );
  });

  it('passes generated SQL through the Phase 1 gate without changing its limit', () => {
    for (const engine of engines) {
      const compiled = compileMetric(registry, 'film_count', engine.dialect);
      const plan = buildPlan(compiled.sql, { dialect: engine.dialect });
      expect(plan.appliedLimit).toBe(compiled.appliedLimit);
      expect(plan.appliedPolicies).toContain('read-only');
    }
  });

  it('executes with matching results on Pagila and Sakila', async () => {
    const results = await Promise.all(engines.map(async (engine) => {
      const compiled = compileMetric(registry, 'film_count', engine.dialect);
      const rows = await engine.db.execute(buildPlan(compiled.sql, { dialect: engine.dialect })) as any[];
      return Number(rows[0].film_count);
    }));

    expect(results).toEqual([EXPECTED.film, EXPECTED.film]);
  });

  it('resolves and executes a dimension join in both dialects', async () => {
    const results = await Promise.all(engines.map(async (engine) => {
      const compiled = compileSelection(registry, {
        metric: 'film_count',
        dimensions: [{ model: 'language', column: 'name' }],
      }, engine.dialect);
      expect(compiled.models).toEqual(['film', 'language']);
      const rows = await engine.db.execute(buildPlan(compiled.sql, { dialect: engine.dialect })) as any[];
      return rows.map((row) => ({ language: String(row.language_name).trim(), count: Number(row.film_count) }));
    }));

    for (const rows of results) {
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(EXPECTED.film);
    }
  });
});
