import { describe, expect, it } from 'vitest';
import {
  MdlValidationError,
  parseMdlYaml,
  stringifyMdlYaml,
} from '../../src/semantic/schema.js';
import { PROVENANCE_VALUES } from '../../src/semantic/types.js';

const completeMdl = `models:
  - name: film
    description: A rentable film title.
    provenance: db_comment
    verified: true
    source: pagila
    table: film
    kind: table
    columns:
      - name: film_id
        description: Stable film identifier.
        provenance: introspection
        verified: true
        dataType: integer
        sourceColumn: film_id
        nullable: false
        isPrimaryKey: true
        isUnique: true
relationships:
  - name: film_language
    description: Each film is recorded in one language.
    provenance: introspection
    verified: true
    fromModel: film
    toModel: language
    cardinality: many-to-one
    joinKeys:
      - fromColumn: language_id
        toColumn: language_id
metrics:
  - name: film_count
    description: Number of film titles.
    provenance: human
    verified: true
    model: film
    expression: COUNT(film_id)
views:
  - name: film_catalog
    description: Fields used in the public catalog.
    provenance: human
    verified: true
    model: film
    columns: [film_id]
    metrics: [film_count]
cubes:
  - name: film_analytics
    description: Film measures grouped by catalog attributes.
    provenance: human
    verified: true
    model: film
    dimensions: [rating]
    measures: [film_count]
`;

describe('MDL YAML schema', () => {
  it('round-trips every R3.2 entity without losing information', () => {
    const parsed = parseMdlYaml(completeMdl);
    const canonical = stringifyMdlYaml(parsed);
    const reparsed = parseMdlYaml(canonical);

    expect(reparsed).toEqual(parsed);
    expect(stringifyMdlYaml(reparsed)).toBe(canonical);
    expect(parsed.models[0].columns).toHaveLength(1);
    expect(parsed.relationships).toHaveLength(1);
    expect(parsed.metrics).toHaveLength(1);
    expect(parsed.views).toHaveLength(1);
    expect(parsed.cubes).toHaveLength(1);
  });

  it('rejects an unknown top-level key and reports its line', () => {
    const yaml = `models: []\nmetrics: []\nmetrcis: []\n`;

    try {
      parseMdlYaml(yaml);
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(MdlValidationError);
      expect((error as MdlValidationError).line).toBe(3);
      expect((error as Error).message).toMatch(/unrecognized key.*line 3/i);
    }
  });

  it('rejects a relationship with no join keys', () => {
    const yaml = completeMdl.replace(
      `    joinKeys:\n      - fromColumn: language_id\n        toColumn: language_id\n`,
      '',
    );
    expect(() => parseMdlYaml(yaml)).toThrow(/joinKeys.*Required/i);
  });

  it.each(PROVENANCE_VALUES)('accepts the documented provenance %s', (provenance) => {
    const yaml = completeMdl.replace('provenance: db_comment', `provenance: ${provenance}`);
    expect(parseMdlYaml(yaml).models[0].provenance).toBe(provenance);
  });

  it('rejects provenance outside the documented six values', () => {
    expect(() => parseMdlYaml(
      completeMdl.replace('provenance: db_comment', 'provenance: guessed'),
    )).toThrow(/invalid enum value/i);
  });

  it('defaults verified to false for every entity level', () => {
    const parsed = parseMdlYaml(completeMdl.replaceAll(/\n\s+verified: true/g, ''));

    expect(parsed.models[0].verified).toBe(false);
    expect(parsed.models[0].columns[0].verified).toBe(false);
    expect(parsed.relationships[0].verified).toBe(false);
    expect(parsed.metrics[0].verified).toBe(false);
    expect(parsed.views[0].verified).toBe(false);
    expect(parsed.cubes[0].verified).toBe(false);
  });

  it('rejects unknown nested keys instead of silently stripping them', () => {
    const yaml = completeMdl.replace('    source: pagila', '    source: pagila\n    tabel: film');
    expect(() => parseMdlYaml(yaml)).toThrow(/unrecognized key/i);
  });
});
