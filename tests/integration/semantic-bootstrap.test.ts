import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresDatabase } from '../../src/postgres.js';
import { bootstrapMdl } from '../../src/semantic/bootstrap.js';
import { parseMdlYaml } from '../../src/semantic/schema.js';
import { PAGILA } from '../helpers/sources.js';

let db: PostgresDatabase;
let directory: string;
let outputPath: string;

beforeAll(async () => {
  db = new PostgresDatabase(PAGILA);
  await db.connect();
  directory = await mkdtemp(join(tmpdir(), 'data-store-mcp-bootstrap-'));
  outputPath = join(directory, 'pagila.yml');
}, 60_000);

afterAll(async () => {
  await (db as any).pool?.end();
  await rm(directory, { recursive: true, force: true });
});

describe('MDL bootstrap / Pagila', () => {
  it('emits every relation and column with matching types and safe provenance', async () => {
    const result = await bootstrapMdl(db, {
      source: PAGILA.id,
      outputPath,
      profile: { maxDistinctForTopValues: 20, topValueLimit: 10 },
    });
    const parsed = parseMdlYaml(await readFile(outputPath, 'utf8'));
    const tables = (await db.listTables()).filter((table) => table.kind === 'table');
    const tableNames = new Set(tables.map((table) => table.name));
    const liveColumns = (await db.getSchema()).filter((column) => tableNames.has(column.table));

    expect(result.changed).toBe(true);
    expect(parsed.models.map((model) => model.name).sort())
      .toEqual(tables.map((table) => table.name).sort());
    expect(parsed.models.flatMap((model) => model.columns)).toHaveLength(liveColumns.length);

    const types = new Map(liveColumns.map((column) => [`${column.table}.${column.name}`, column.dataType]));
    for (const model of parsed.models) {
      expect(model.verified).toBe(false);
      expect(model.provenance).toBe('introspection');
      for (const column of model.columns) {
        expect(column.verified).toBe(false);
        expect(column.provenance).toBe('introspection');
        expect(column.dataType).toBe(types.get(`${model.name}.${column.name}`));
      }
    }

    const rating = parsed.models.find((model) => model.name === 'film')
      ?.columns.find((column) => column.name === 'rating');
    expect(rating?.profile?.topValues?.length).toBeGreaterThan(0);
  }, 60_000);

  it('is idempotent and never appends duplicate models', async () => {
    await bootstrapMdl(db, {
      source: PAGILA.id,
      outputPath,
      profile: { maxDistinctForTopValues: 20, topValueLimit: 10 },
    });
    const before = await readFile(outputPath, 'utf8');
    const second = await bootstrapMdl(db, {
      source: PAGILA.id,
      outputPath,
      profile: { maxDistinctForTopValues: 20, topValueLimit: 10 },
    });
    const after = await readFile(outputPath, 'utf8');

    expect(second.changed).toBe(false);
    expect(after).toBe(before);
    expect(new Set(second.document.models.map((model) => model.name)).size)
      .toBe(second.document.models.length);
  }, 60_000);
});
