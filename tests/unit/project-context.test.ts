import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextFileError,
  loadProjectContext,
  parseQueriesYaml,
} from '../../src/orchestrator/context.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('version-controlled project context', () => {
  it('loads instructions and approved question/SQL pairs', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'instructions.md'), '# Rules\nUse net revenue.\n', 'utf8');
    await writeFile(join(directory, 'queries.yml'), `queries:
  - question: How many films are available?
    sql: SELECT count(*) FROM film
  - question: Which languages are used?
    sql: SELECT DISTINCT name FROM language
`, 'utf8');

    await expect(loadProjectContext(directory)).resolves.toEqual({
      instructions: '# Rules\nUse net revenue.\n',
      queries: [
        { question: 'How many films are available?', sql: 'SELECT count(*) FROM film' },
        { question: 'Which languages are used?', sql: 'SELECT DISTINCT name FROM language' },
      ],
    });
  });

  it('returns empty context when both optional files are absent', async () => {
    const directory = await temporaryDirectory();
    await expect(loadProjectContext(directory)).resolves.toEqual({ instructions: '', queries: [] });
  });

  it('reports malformed YAML with its file and line', () => {
    const file = '/project/queries.yml';
    expect(() => parseQueriesYaml(`queries:\n  - question: broken\n    sql: [\n`, file))
      .toThrow(ContextFileError);
    try {
      parseQueriesYaml(`queries:\n  - question: broken\n    sql: [\n`, file);
    } catch (error) {
      expect((error as ContextFileError).file).toBe(file);
      expect((error as ContextFileError).line).toBe(4);
      expect((error as Error).message).toContain(`${file}:4:`);
    }
  });

  it('rejects an entry missing required sql with a location', () => {
    const file = '/project/queries.yml';
    try {
      parseQueriesYaml(`queries:\n  - question: Missing SQL\n`, file);
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ContextFileError);
      expect((error as ContextFileError).line).toBe(2);
      expect((error as Error).message).toMatch(/queries\.0\.sql.*required/i);
    }
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'data-store-mcp-context-'));
  directories.push(directory);
  return directory;
}
