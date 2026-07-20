import { describe, expect, it, vi } from 'vitest';
import { draftMdl } from '../../src/semantic/draft.js';
import { parseMdlYaml, stringifyMdlYaml } from '../../src/semantic/schema.js';
import type { MdlDocument } from '../../src/semantic/types.js';

describe('LLM drafting boundary', () => {
  it('uses schema/profile/artifact evidence and forces generated content unverified', async () => {
    let prompt = '';
    const client = {
      draft: vi.fn(async (value: string) => {
        prompt = value;
        return {
          description: 'Customer-facing films available for rental.',
          verified: true,
          metrics: [{
            name: 'film_count',
            description: 'Number of film records.',
            expression: 'COUNT(film_id)',
            verified: true,
          }],
        };
      }),
    };

    const drafted = await draftMdl(fixture(), {
      client,
      artifacts: ['SELECT rating, count(*) FROM film GROUP BY rating'],
    });

    expect(client.draft).toHaveBeenCalledOnce();
    expect(prompt).toContain('Table: film');
    expect(prompt).toContain('"name": "title"');
    expect(prompt).toContain('"name": "rating"');
    expect(prompt).toContain('PG-13');
    expect(prompt).toContain('SELECT rating, count(*) FROM film GROUP BY rating');
    expect(drafted.models[0]).toEqual(expect.objectContaining({
      description: 'Customer-facing films available for rental.',
      provenance: 'llm_draft',
      verified: false,
    }));
    expect(drafted.metrics[0]).toEqual(expect.objectContaining({
      name: 'film_count',
      provenance: 'llm_draft',
      verified: false,
    }));
  });

  it('leaves the description empty when a stub returns malformed output', async () => {
    const client = { draft: vi.fn(async () => ({ description: 42, verified: true })) };
    const drafted = await draftMdl(fixture(), { client });

    expect(drafted.models[0].description).toBe('');
    expect(drafted.models[0].verified).toBe(false);
    expect(drafted.metrics).toEqual([]);
    expect(parseMdlYaml(stringifyMdlYaml(drafted)).models[0].description).toBe('');
  });

  it('does not mutate the structural bootstrap document', async () => {
    const input = fixture();
    await draftMdl(input, { client: { draft: async () => ({ description: 'Draft' }) } });
    expect(input.models[0].description).toBe('Structural placeholder.');
    expect(input.models[0].provenance).toBe('introspection');
  });
});

function fixture(): MdlDocument {
  return {
    models: [{
      name: 'film',
      description: 'Structural placeholder.',
      provenance: 'introspection',
      verified: false,
      source: 'fixture',
      table: 'film',
      kind: 'table',
      columns: [
        {
          name: 'film_id',
          description: 'Identifier.',
          provenance: 'introspection',
          verified: false,
          dataType: 'integer',
          profile: { distinctCount: 1000, nullRate: 0 },
        },
        {
          name: 'title',
          description: 'Title.',
          provenance: 'introspection',
          verified: false,
          dataType: 'text',
          profile: { distinctCount: 1000, nullRate: 0 },
        },
        {
          name: 'rating',
          description: 'Rating.',
          provenance: 'introspection',
          verified: false,
          dataType: 'text',
          profile: {
            distinctCount: 5,
            nullRate: 0,
            topValues: [{ value: 'PG-13', count: 223 }],
          },
        },
      ],
    }],
    relationships: [],
    metrics: [],
    views: [],
    cubes: [],
  };
}
