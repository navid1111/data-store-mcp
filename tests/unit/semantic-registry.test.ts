import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SemanticRegistry } from '../../src/semantic/registry.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('SemanticRegistry', () => {
  it('loads nested YAML files into case-sensitive O(1) indexes', async () => {
    const directory = await fixtureDirectory();
    const registry = await SemanticRegistry.load(directory);

    expect(registry.getModel('film')?.table).toBe('film');
    expect(registry.getModel('Film')).toBeUndefined();
    expect(registry.getMetric('film_count')?.expression).toBe('COUNT(film_id)');
    expect(registry.getMetric('FILM_COUNT')).toBeUndefined();
    expect(registry.document.relationships[0].name).toBe('film_language');
  });

  it('rejects duplicate model names and names both source paths', async () => {
    const directory = await temporaryDirectory();
    const first = join(directory, 'first.yml');
    const second = join(directory, 'second.yml');
    await writeFile(first, modelYaml('film', 'film'));
    await writeFile(second, modelYaml('film', 'film_archive'));

    await expect(SemanticRegistry.load(directory)).rejects.toThrow(
      new RegExp(`Duplicate model name.*${escapeRegExp(first)}.*${escapeRegExp(second)}`),
    );
  });

  it('rejects a relationship that references an undefined model', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'film.yml'), modelYaml('film', 'film'));
    await writeFile(join(directory, 'relationship.yml'), relationshipYaml('missing_language'));

    await expect(SemanticRegistry.load(directory)).rejects.toThrow(
      /relationship film_language references undefined model "missing_language"/,
    );
  });

  it('produces identical contents regardless of input file order', async () => {
    const directory = await fixtureDirectory();
    const paths = [
      join(directory, 'models', 'language.yaml'),
      join(directory, 'metrics.yml'),
      join(directory, 'models', 'film.yml'),
      join(directory, 'relationships.yml'),
    ];

    const forward = await SemanticRegistry.loadFiles(paths);
    const shuffled = await SemanticRegistry.loadFiles([paths[2], paths[0], paths[3], paths[1]]);
    expect(shuffled.document).toEqual(forward.document);
  });

  it('fails loudly when one file is invalid', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'invalid.yml');
    await writeFile(path, 'models: []\nunknown: true\n');
    await expect(SemanticRegistry.load(directory)).rejects.toThrow(
      new RegExp(`Invalid MDL file ${escapeRegExp(path)}.*line 2`),
    );
  });
});

async function fixtureDirectory(): Promise<string> {
  const directory = await temporaryDirectory();
  await mkdir(join(directory, 'models'));
  await Promise.all([
    writeFile(join(directory, 'models', 'film.yml'), modelYaml('film', 'film')),
    writeFile(join(directory, 'models', 'language.yaml'), modelYaml('language', 'language')),
    writeFile(join(directory, 'relationships.yml'), relationshipYaml('language')),
    writeFile(join(directory, 'metrics.yml'), `metrics:
  - name: film_count
    description: Number of films.
    provenance: human
    verified: true
    model: film
    expression: COUNT(film_id)
`),
  ]);
  return directory;
}

function modelYaml(name: string, table: string): string {
  return `models:
  - name: ${name}
    description: ${name} records.
    provenance: introspection
    source: pagila
    table: ${table}
    columns:
      - name: ${name}_id
        description: Identifier.
        provenance: introspection
        dataType: integer
`;
}

function relationshipYaml(toModel: string): string {
  return `relationships:
  - name: film_language
    description: Film language.
    provenance: introspection
    fromModel: film
    toModel: ${toModel}
    cardinality: many-to-one
    joinKeys:
      - fromColumn: language_id
        toColumn: language_id
`;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'data-store-mcp-semantic-'));
  directories.push(directory);
  return directory;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
