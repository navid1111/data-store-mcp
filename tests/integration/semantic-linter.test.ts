import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresDatabase } from '../../src/postgres.js';
import { lintMdlFile } from '../../src/semantic/linter.js';
import { stringifyMdlYaml } from '../../src/semantic/schema.js';
import type { MdlDocument, Model, Relationship } from '../../src/semantic/types.js';
import { PAGILA } from '../helpers/sources.js';

const CLEAN_PARENT = 'dsm_test_lint_clean_parent';
const CLEAN_CHILD = 'dsm_test_lint_clean_child';
const DRIFT_PARENT = 'dsm_test_lint_drift_parent';
const DRIFT_CHILD = 'dsm_test_lint_drift_child';
const DROPPED = 'dsm_test_lint_dropped';
const CLEAN_FK = 'dsm_test_lint_clean_fk';
const DRIFT_FK = 'dsm_test_lint_drift_fk';

let db: PostgresDatabase;
let directory: string;
let cleanPath: string;
let driftPath: string;

beforeAll(async () => {
  db = new PostgresDatabase(PAGILA);
  await db.connect();
  await dropScratchTables();
  await db.query(`CREATE TABLE ${CLEAN_PARENT} (parent_id integer PRIMARY KEY)`);
  await db.query(`
    CREATE TABLE ${CLEAN_CHILD} (
      child_id integer PRIMARY KEY,
      parent_id integer NOT NULL,
      CONSTRAINT ${CLEAN_FK} FOREIGN KEY (parent_id) REFERENCES ${CLEAN_PARENT}(parent_id)
    )
  `);
  await db.query(`CREATE TABLE ${DRIFT_PARENT} (parent_id integer PRIMARY KEY)`);
  await db.query(`
    CREATE TABLE ${DRIFT_CHILD} (
      child_id integer PRIMARY KEY,
      parent_id integer NOT NULL,
      removed_value text,
      changed_value text,
      CONSTRAINT ${DRIFT_FK} FOREIGN KEY (parent_id) REFERENCES ${DRIFT_PARENT}(parent_id)
    )
  `);
  await db.query(`CREATE TABLE ${DROPPED} (dropped_id integer PRIMARY KEY)`);

  directory = await mkdtemp(join(tmpdir(), 'data-store-mcp-lint-'));
  cleanPath = join(directory, 'clean.yml');
  driftPath = join(directory, 'drift.yml');
  await writeFile(cleanPath, stringifyMdlYaml(cleanDocument()), 'utf8');
  await writeFile(driftPath, stringifyMdlYaml(driftDocument()), 'utf8');

  await db.query(`DROP TABLE ${DROPPED}`);
  await db.query(`ALTER TABLE ${DRIFT_CHILD} DROP COLUMN removed_value`);
  await db.query(`ALTER TABLE ${DRIFT_CHILD} ALTER COLUMN changed_value TYPE integer USING 0`);
  await db.query(`ALTER TABLE ${DRIFT_CHILD} DROP CONSTRAINT ${DRIFT_FK}`);
}, 60_000);

afterAll(async () => {
  await dropScratchTables().catch(() => undefined);
  await (db as any).pool?.end();
  await rm(directory, { recursive: true, force: true });
});

describe('MDL live-schema drift lint', () => {
  it('exits zero for an unchanged MDL', async () => {
    await expect(lintMdlFile(db, cleanPath)).resolves.toEqual({ findings: [], exitCode: 0 });
  });

  it('detects every required drift class with file and line locations', async () => {
    const result = await lintMdlFile(db, driftPath);

    expect(result.exitCode).toBe(1);
    expect(result.findings.map((finding) => finding.code).sort()).toEqual([
      'column_type_changed',
      'missing_column',
      'missing_foreign_key',
      'missing_model_table',
    ]);
    for (const finding of result.findings) {
      expect(finding.file).toBe(driftPath);
      expect(finding.line).toBeGreaterThan(0);
      expect(finding.column).toBeGreaterThan(0);
      expect(finding.message).toContain(`${driftPath}:${finding.line}:${finding.column}`);
    }
  });
});

function cleanDocument(): MdlDocument {
  return document(
    [
      model(CLEAN_PARENT, [column('parent_id', 'integer')]),
      model(CLEAN_CHILD, [column('child_id', 'integer'), column('parent_id', 'integer')]),
    ],
    [relationship('clean_child_parent', CLEAN_CHILD, CLEAN_PARENT)],
  );
}

function driftDocument(): MdlDocument {
  return document(
    [
      model(DROPPED, [column('dropped_id', 'integer')]),
      model(DRIFT_PARENT, [column('parent_id', 'integer')]),
      model(DRIFT_CHILD, [
        column('child_id', 'integer'),
        column('parent_id', 'integer'),
        column('removed_value', 'text'),
        column('changed_value', 'text'),
      ]),
    ],
    [relationship('drift_child_parent', DRIFT_CHILD, DRIFT_PARENT)],
  );
}

function document(models: Model[], relationships: Relationship[]): MdlDocument {
  return { models, relationships, metrics: [], views: [], cubes: [] };
}

function model(name: string, columns: Model['columns']): Model {
  return {
    name,
    description: `Model ${name}.`,
    provenance: 'human',
    verified: true,
    source: PAGILA.id,
    table: name,
    kind: 'table',
    columns,
  };
}

function column(name: string, dataType: string): Model['columns'][number] {
  return {
    name,
    description: `Column ${name}.`,
    provenance: 'human',
    verified: true,
    dataType,
    sourceColumn: name,
  };
}

function relationship(name: string, fromModel: string, toModel: string): Relationship {
  return {
    name,
    description: `Relationship ${name}.`,
    provenance: 'human',
    verified: true,
    fromModel,
    toModel,
    cardinality: 'many-to-one',
    joinKeys: [{ fromColumn: 'parent_id', toColumn: 'parent_id' }],
  };
}

async function dropScratchTables(): Promise<void> {
  await db.query(`
    DROP TABLE IF EXISTS
      ${CLEAN_CHILD}, ${CLEAN_PARENT}, ${DRIFT_CHILD}, ${DRIFT_PARENT}, ${DROPPED}
    CASCADE
  `);
}
