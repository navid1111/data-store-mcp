import { describe, expect, it } from 'vitest';
import { lintDescriptionCoverage } from '../../src/semantic/linter.js';
import { parseMdlYaml } from '../../src/semantic/schema.js';

const yaml = `models:
  - name: film
    provenance: human
    verified: true
    source: pagila
    table: film
    kind: table
    columns:
      - name: film_id
        description: "   "
        provenance: human
        verified: true
        dataType: integer
metrics:
  - name: film_count
    description: ""
    provenance: human
    verified: true
    model: film
    expression: COUNT(film_id)
relationships: []
views: []
cubes: []
`;

describe('semantic description coverage lint', () => {
  it('reports missing, empty, and whitespace descriptions by entity path', () => {
    const document = parseMdlYaml(yaml);
    expect(document.models[0].description).toBe('');

    expect(lintDescriptionCoverage(document).map((finding) => finding.entityPath)).toEqual([
      'model.film',
      'model.film.column.film_id',
      'metric.film_count',
    ]);
  });

  it('passes when every model, column, and metric is described', () => {
    const document = parseMdlYaml(yaml
      .replace('    provenance: human', '    description: Film catalog.\n    provenance: human')
      .replace('        description: "   "', '        description: Stable film identifier.')
      .replace('    description: ""', '    description: Number of films.'));

    expect(lintDescriptionCoverage(document)).toEqual([]);
  });
});
