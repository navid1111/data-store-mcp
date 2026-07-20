import { describe, expect, it } from 'vitest';
import { mineQueryLog } from '../../src/semantic/artifacts.js';

const fixture = new URL('../semantic-query-log.fixture.txt', import.meta.url).pathname;

describe('checked-in SQL artifact mining', () => {
  it('ranks repeated joins by frequency and ignores one-offs', async () => {
    const result = await mineQueryLog(fixture, { dialect: 'postgres', minimumFrequency: 2 });

    expect(result.relationships.map((candidate) => candidate.frequency)).toEqual([3, 2]);
    expect(result.relationships[0]).toEqual(expect.objectContaining({
      fromModel: 'film',
      toModel: 'language',
      joinKeys: [{ fromColumn: 'language_id', toColumn: 'language_id' }],
      provenance: 'query_log',
      verified: false,
    }));
    expect(result.relationships.some((candidate) => candidate.name.includes('one_off'))).toBe(false);
  });

  it('proposes only recurring filters and aggregates', async () => {
    const result = await mineQueryLog(fixture, { dialect: 'postgres', minimumFrequency: 2 });

    expect(result.rules).toEqual([
      expect.objectContaining({
        expression: "f.rating = 'PG-13'",
        frequency: 3,
        provenance: 'query_log',
        verified: false,
      }),
      expect.objectContaining({
        expression: "f.rating = 'G'",
        frequency: 2,
        provenance: 'query_log',
        verified: false,
      }),
    ]);
    expect(result.rules.some((rule) => rule.expression.includes('length > 120'))).toBe(false);
    expect(result.metrics).toEqual([
      expect.objectContaining({ name: 'count_rows', frequency: 2, verified: false }),
    ]);
  });

  it('skips an unparseable line with a line-numbered warning', async () => {
    const result = await mineQueryLog(fixture, { dialect: 'postgres' });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toEqual(expect.objectContaining({ line: 7 }));
  });
});
