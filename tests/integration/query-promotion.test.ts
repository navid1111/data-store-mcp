import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promoteQuery } from '../../src/memory/promote.js';
import { parseQueriesYaml } from '../../src/orchestrator/context.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('approved query promotion', () => {
  it('requires explicit approval and leaves the file untouched when denied', async () => {
    const { path, source } = await fixtureFile();
    await expect(promoteQuery(path, {
      approved: false,
      question: 'Denied question',
      sql: 'SELECT 1',
      expected: [{ value: 1 }],
    })).rejects.toThrow(/explicit approved: true/i);
    expect(await readFile(path, 'utf8')).toBe(source);
  });

  it('appends a stable golden entry without reformatting existing content', async () => {
    const { path, source } = await fixtureFile();
    const result = await promoteQuery(path, {
      approved: true,
      question: 'How many actors are there?',
      sql: 'SELECT count(*) AS count FROM actor',
      expected: [{ count: 200 }],
    });
    const after = await readFile(path, 'utf8');

    expect(result).toEqual({ changed: true, total: 2 });
    expect(after.startsWith(source)).toBe(true);
    const appended = after.slice(source.length);
    expect(appended.indexOf('question:')).toBeLessThan(appended.indexOf('sql:'));
    expect(appended.indexOf('sql:')).toBeLessThan(appended.indexOf('expected:'));
    expect(parseQueriesYaml(after, path)).toHaveLength(2);
  });

  it('is idempotent for the same approved question and result', async () => {
    const { path } = await fixtureFile();
    const promotion = {
      approved: true,
      question: 'How many actors are there?',
      sql: 'SELECT count(*) AS count FROM actor',
      expected: [{ count: 200 }],
    } as const;
    await promoteQuery(path, promotion);
    const once = await readFile(path, 'utf8');
    expect(await promoteQuery(path, promotion)).toEqual({ changed: false, total: 2 });
    expect(await readFile(path, 'utf8')).toBe(once);
  });
});

async function fixtureFile(): Promise<{ path: string; source: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'data-store-mcp-promotion-'));
  directories.push(directory);
  const path = join(directory, 'queries.yml');
  const source = `# Approved examples — keep this comment\nqueries:\n  - question: Existing case\n    sql: SELECT 1 AS value\n    expected:\n      - value: 1\n`;
  await writeFile(path, source, 'utf8');
  return { path, source };
}
