import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SemanticRegistry } from '../../src/semantic/registry.js';
import { editDistance, resolveColumn, resolveModel, suggestNames } from '../../src/semantic/resolve.js';

let registry: SemanticRegistry;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'data-store-mcp-resolve-'));
  await writeFile(join(directory, 'models.yml'), `models:
  - name: film
    description: Films.
    provenance: human
    source: fixture
    table: film
    columns:
      - name: title
        description: Film title.
        provenance: human
        dataType: text
      - name: rating
        description: Content rating.
        provenance: human
        dataType: text
      - name: replacement_cost
        description: Replacement cost.
        provenance: human
        dataType: numeric
  - name: actor
    description: Actors.
    provenance: human
    source: fixture
    table: actor
    columns:
      - name: actor_id
        description: Actor identifier.
        provenance: human
        dataType: integer
`);
  registry = await SemanticRegistry.load(directory);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('semantic identifier resolution', () => {
  it('suggests title for titel', () => {
    const model = resolveModel(registry, 'film');
    expect(() => resolveColumn(model, 'titel')).toThrowError(
      expect.objectContaining({ detail: expect.objectContaining({ didYouMean: ['title'] }) }),
    );
  });

  it('suggests film for the transposition flim', () => {
    expect(editDistance('flim', 'film')).toBe(1);
    expect(() => resolveModel(registry, 'flim')).toThrowError(
      expect.objectContaining({ detail: expect.objectContaining({ didYouMean: ['film'] }) }),
    );
  });

  it('ranks by distance and caps suggestions at three', () => {
    expect(suggestNames('rate', ['late', 'rating', 'date', 'crate', 'unrelated']))
      .toEqual(['crate', 'date', 'late']);
  });

  it('returns no nonsense suggestion for an unrelated token', () => {
    expect(suggestNames('zzzzzz', ['title', 'rating', 'replacement_cost'])).toEqual([]);
  });

  it('never leaks a CLAC-hidden column through suggestions or exact lookup', () => {
    const model = resolveModel(registry, 'film');
    const hidden = new Set(['replacement_cost']);

    expect(suggestNames('replacment_cost', model.columns.map((column) => column.name), { hidden }))
      .toEqual([]);
    expect(() => resolveColumn(model, 'replacement_cost', { hidden })).toThrowError(
      expect.objectContaining({ detail: expect.objectContaining({ didYouMean: [] }) }),
    );
  });

  it('draws candidates from MDL rather than the live database', () => {
    expect(suggestNames('titel', registry.document.models.flatMap(
      (model) => model.columns.map((column) => column.name),
    ))).toEqual(['title']);
  });
});
