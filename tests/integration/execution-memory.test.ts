import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionMemoryIndex } from '../../src/memory/index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('successful execution memory / LanceDB', () => {
  it('stores question, SQL, result shape and timing', async () => {
    const index = await openIndex();
    await expect(index.recordExecution({
      success: true,
      question: 'Which films are active?',
      sql: 'SELECT film_id, title FROM film WHERE active',
      rows: [{ film_id: 1, title: 'ACADEMY DINOSAUR' }],
      durationMs: 12.5,
    })).resolves.toBe(true);

    expect(await index.records()).toEqual([
      expect.objectContaining({
        question: 'Which films are active?',
        sql: 'SELECT film_id, title FROM film WHERE active',
        resultShape: [
          { name: 'film_id', type: 'number' },
          { name: 'title', type: 'string' },
        ],
        durationMs: 12.5,
        recordedAt: expect.any(String),
      }),
    ]);
    index.close();
  });

  it('updates the same normalized question instead of duplicating it', async () => {
    const index = await openIndex();
    await index.recordExecution({
      success: true,
      question: 'How many films?',
      sql: 'SELECT count(*) AS count FROM film',
      rows: [{ count: 1000 }],
      durationMs: 8,
    });
    await index.recordExecution({
      success: true,
      question: '  HOW   MANY FILMS? ',
      sql: 'SELECT count(film_id) AS count FROM film',
      rows: [{ count: 1000 }],
      durationMs: 6,
    });

    expect(await index.count()).toBe(1);
    expect((await index.records())[0]).toEqual(expect.objectContaining({
      sql: 'SELECT count(film_id) AS count FROM film',
      durationMs: 6,
    }));
    index.close();
  });

  it('survives reopening the local index', async () => {
    const directory = await temporaryDirectory();
    const first = await ExecutionMemoryIndex.open(directory);
    await first.recordExecution({
      success: true,
      question: 'List languages',
      sql: 'SELECT name FROM language',
      rows: [{ name: 'English' }],
      durationMs: 3,
    });
    first.close();

    const reopened = await ExecutionMemoryIndex.open(directory);
    expect(await reopened.records()).toEqual([
      expect.objectContaining({ question: 'List languages', sql: 'SELECT name FROM language' }),
    ]);
    reopened.close();
  });

  it('does not index failed executions', async () => {
    const index = await openIndex();
    await expect(index.recordExecution({
      success: false,
      question: 'Broken query',
      sql: 'SELECT missing FROM film',
      durationMs: 2,
      error: 'column does not exist',
    })).resolves.toBe(false);
    expect(await index.count()).toBe(0);
    expect(await index.records()).toEqual([]);
    index.close();
  });
});

async function openIndex(): Promise<ExecutionMemoryIndex> {
  return ExecutionMemoryIndex.open(await temporaryDirectory());
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'data-store-mcp-memory-'));
  directories.push(directory);
  return directory;
}
