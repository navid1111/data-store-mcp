import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askQuestion } from '../../src/orchestrator/ask.js';
import { loadProjectContext } from '../../src/orchestrator/context.js';
import { SemanticRegistry } from '../../src/semantic/registry.js';
import { ExecutionMemoryIndex } from '../../src/memory/index.js';
import { HybridMemoryRetriever } from '../../src/memory/retrieval.js';
import { HashEmbeddingProvider } from '../../src/memory/embedding.js';

let directory: string;
let semantic: SemanticRegistry;
let project: Awaited<ReturnType<typeof loadProjectContext>>;
let memory: ExecutionMemoryIndex;
let retriever: HybridMemoryRetriever;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'data-store-mcp-ask-'));
  const semanticPath = join(directory, 'semantic');
  await mkdir(semanticPath);
  await writeFile(join(semanticPath, 'film.yml'), `models:
  - name: film
    description: Customer-facing film catalog.
    provenance: human
    verified: true
    source: fixture
    table: film
    columns:
      - name: film_id
        description: Stable film identifier.
        provenance: human
        verified: true
        dataType: integer
      - name: title
        description: Public film title.
        provenance: human
        verified: true
        dataType: text
      - name: secret_note
        description: Internal acquisition notes.
        provenance: human
        verified: true
        dataType: text
metrics:
  - name: film_count
    description: Number of films.
    provenance: human
    verified: true
    model: film
    expression: COUNT(film_id)
  - name: noted_film_count
    description: Films with internal notes.
    provenance: human
    verified: true
    model: film
    expression: COUNT(secret_note)
`, 'utf8');
  await writeFile(join(directory, 'instructions.md'),
    '# Business rules\nUse active catalog records. Never expose secret_note.\n', 'utf8');
  await writeFile(join(directory, 'queries.yml'), `queries:
  - question: How many films are in the catalog?
    sql: SELECT COUNT(*) AS film_count FROM film
  - question: Which films have internal notes?
    sql: SELECT secret_note FROM film
`, 'utf8');

  semantic = await SemanticRegistry.load(semanticPath);
  project = await loadProjectContext(directory);
  memory = await ExecutionMemoryIndex.open(join(directory, 'memory'));
  await memory.recordExecution({
    success: true,
    question: 'Count films in the public catalog',
    sql: 'SELECT COUNT(*) AS film_count FROM film',
    rows: [{ film_count: 1000 }],
    durationMs: 12,
  });
  await memory.recordExecution({
    success: true,
    question: 'Find internal acquisition notes',
    sql: 'SELECT secret_note FROM film',
    rows: [{ secret_note: 'private' }],
    durationMs: 9,
  });
  retriever = new HybridMemoryRetriever(memory, new HashEmbeddingProvider());
}, 60_000);

afterAll(async () => {
  memory.close();
  await rm(directory, { recursive: true, force: true });
});

describe('guided and direct ask prompting', () => {
  it('changes the actual LLM prompt and excludes CLAC-hidden columns from every context source', async () => {
    const prompts: string[] = [];
    const client = {
      complete: vi.fn(async (prompt: string) => {
        prompts.push(prompt);
        return 'A stubbed answer.';
      }),
    };
    const question = 'How many films are in the catalog?';

    const guided = await askQuestion(question, {
      mode: 'guided',
      client,
      guided: {
        semantic,
        project,
        retriever,
        hiddenColumns: new Set(['film.secret_note']),
      },
    });
    const direct = await askQuestion(question, { mode: 'direct', client });

    expect(client.complete).toHaveBeenCalledTimes(2);
    expect(prompts).toEqual([guided.prompt, direct.prompt]);
    expect(direct.prompt).toBe(question);
    expect(guided.prompt).not.toBe(direct.prompt);
    expect(guided.prompt).toContain('## Visible semantic schema');
    expect(guided.prompt).toContain('Public film title.');
    expect(guided.prompt).toContain('## Project instructions');
    expect(guided.prompt).toContain('Use active catalog records.');
    expect(guided.prompt).toContain('## Retrieved precedents');
    expect(guided.prompt).toContain('Count films in the public catalog');
    expect(guided.prompt).toContain('PRIOR ART — example only, not ground truth');
    expect(guided.prompt).toContain('[CLAC REDACTED]');
    expect(guided.prompt.toLowerCase()).not.toContain('secret_note');

    expect(direct.prompt).not.toContain('Visible semantic schema');
    expect(direct.prompt).not.toContain('Use active catalog records.');
    expect(direct.prompt).not.toContain('Count films in the public catalog');
  });

  it('requires guided context and rejects empty LLM responses', async () => {
    await expect(askQuestion('question', {
      mode: 'guided',
      client: { complete: async () => 'unused' },
    })).rejects.toThrow('Guided ask requires semantic and project context');

    await expect(askQuestion('question', {
      mode: 'direct',
      client: { complete: async () => '   ' },
    })).rejects.toThrow('empty response');
  });
});
