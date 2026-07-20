import { describe, expect, it } from 'vitest';
import { JoinPathError, resolveJoinPath } from '../../src/semantic/joinpath.js';
import type { MdlDocument, Model, Relationship } from '../../src/semantic/types.js';

describe('resolveJoinPath', () => {
  it('resolves the single-hop film to language path', () => {
    const path = resolveJoinPath(document(
      ['film', 'language'],
      [relationship('film_language', 'film', 'language')],
    ), 'film', 'language');

    expect(path.models).toEqual(['film', 'language']);
    expect(path.steps.map((step) => step.relationship.name)).toEqual(['film_language']);
    expect(path.steps[0].reversed).toBe(false);
  });

  it('resolves actor to film through film_actor in two hops', () => {
    const path = resolveJoinPath(document(
      ['actor', 'film_actor', 'film'],
      [
        relationship('film_actor_actor', 'film_actor', 'actor'),
        relationship('film_actor_film', 'film_actor', 'film'),
      ],
    ), 'actor', 'film');

    expect(path.models).toEqual(['actor', 'film_actor', 'film']);
    expect(path.steps.map((step) => step.relationship.name)).toEqual([
      'film_actor_actor',
      'film_actor_film',
    ]);
    expect(path.steps[0].reversed).toBe(true);
  });

  it('rejects two routes by name and is independent of relationship order', () => {
    const relationships = [
      relationship('film_category', 'film', 'category'),
      relationship('category_language', 'category', 'language'),
      relationship('film_inventory', 'film', 'inventory'),
      relationship('inventory_language', 'inventory', 'language'),
    ];
    const models = ['film', 'category', 'inventory', 'language'];

    const errorA = capture(() => resolveJoinPath(document(models, relationships), 'film', 'language'));
    const errorB = capture(() => resolveJoinPath(document(models, [...relationships].reverse()), 'film', 'language'));

    expect(errorA.code).toBe('E_AMBIGUOUS_JOIN_PATH');
    expect(errorA.routes).toHaveLength(2);
    expect(errorA.message).toContain('film -> category -> language');
    expect(errorA.message).toContain('film -> inventory -> language');
    expect(errorB.message).toBe(errorA.message);
  });

  it('returns E_NO_JOIN_PATH when models are disconnected', () => {
    const error = capture(() => resolveJoinPath(document(
      ['film', 'actor'],
      [],
    ), 'film', 'actor'));
    expect(error.code).toBe('E_NO_JOIN_PATH');
  });

  it('terminates in the presence of a self-referencing staff FK', () => {
    const mdl = document(
      ['staff', 'store', 'film'],
      [
        relationship('staff_reports_to', 'staff', 'staff'),
        relationship('staff_store', 'staff', 'store'),
      ],
    );
    expect(resolveJoinPath(mdl, 'staff', 'store').models).toEqual(['staff', 'store']);
    expect(() => resolveJoinPath(mdl, 'staff', 'film')).toThrowError(
      expect.objectContaining({ code: 'E_NO_JOIN_PATH' }),
    );
  });
});

function document(modelNames: string[], relationships: Relationship[]): MdlDocument {
  return {
    models: modelNames.map(model),
    relationships,
    metrics: [],
    views: [],
    cubes: [],
  };
}

function model(name: string): Model {
  return {
    name,
    description: name,
    provenance: 'human',
    verified: true,
    source: 'fixture',
    table: name,
    kind: 'table',
    columns: [],
  };
}

function relationship(name: string, fromModel: string, toModel: string): Relationship {
  return {
    name,
    description: name,
    provenance: 'human',
    verified: true,
    fromModel,
    toModel,
    cardinality: 'many-to-one',
    joinKeys: [{ fromColumn: `${toModel}_id`, toColumn: `${toModel}_id` }],
  };
}

function capture(operation: () => unknown): JoinPathError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(JoinPathError);
    return error as JoinPathError;
  }
  throw new Error('expected join-path resolution to fail');
}
