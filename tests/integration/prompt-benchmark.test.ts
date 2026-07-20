import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresDatabase } from '../../src/postgres.js';
import { runPromptBenchmark, type BenchmarkGenerationRequest } from '../../src/evaluation/prompt-benchmark.js';
import { SemanticRegistry } from '../../src/semantic/registry.js';
import { loadProjectContext } from '../../src/orchestrator/context.js';
import { PAGILA } from '../helpers/sources.js';

let database: PostgresDatabase;
let directory: string;
let semantic: SemanticRegistry;
let project: Awaited<ReturnType<typeof loadProjectContext>>;

beforeAll(async () => {
  database = new PostgresDatabase(PAGILA);
  await database.connect();
  directory = await mkdtemp(join(tmpdir(), 'data-store-mcp-prompt-benchmark-'));
  const semanticPath = join(directory, 'semantic');
  await mkdir(semanticPath);
  await writeFile(join(semanticPath, 'benchmark.yml'), `models:
  - name: benchmark_values
    description: Values used by the benchmark.
    provenance: human
    verified: true
    source: test-pagila
    table: film
    columns:
      - name: film_id
        description: Stable fixture value.
        provenance: human
        verified: true
        dataType: integer
`, 'utf8');
  await writeFile(join(directory, 'instructions.md'),
    'Return one SQL SELECT statement and no explanation.\n', 'utf8');
  await writeFile(join(directory, 'queries.yml'), `queries:
  - question: Return benchmark value one
    sql: SELECT 1 AS answer
    expected:
      - answer: 1
  - question: Return benchmark value two
    sql: SELECT 2 AS answer
    expected:
      - answer: 2
  - question: Return benchmark value three
    sql: SELECT 3 AS answer
    expected:
      - answer: 3
`, 'utf8');
  semantic = await SemanticRegistry.load(semanticPath);
  project = await loadProjectContext(directory);
}, 60_000);

afterAll(async () => {
  await (database as unknown as { pool: { end(): Promise<void> } }).pool.end();
  await rm(directory, { recursive: true, force: true });
});

describe('guided-vs-direct prompt benchmark', () => {
  it('uses paired questions and seeds, reports both rates, and is reproducible', async () => {
    const queries = project.queries;
    const calls: Array<{ prompt: string; request: BenchmarkGenerationRequest }> = [];
    const client = {
      generate: async (prompt: string, request: BenchmarkGenerationRequest) => {
        calls.push({ prompt, request });
        const value = request.caseIndex + 1;
        if (request.mode === 'guided') return `\`\`\`sql\nSELECT ${value} AS answer\n\`\`\``;
        return request.caseIndex === 0
          ? 'SELECT 1 AS answer'
          : 'SELECT 99 AS answer';
      },
    };
    const options = {
      dialect: 'postgres' as const,
      seed: 8675309,
      client,
      guided: { semantic, project },
    };

    const first = await runPromptBenchmark(database, queries, options);
    const second = await runPromptBenchmark(database, queries, options);

    expect(second).toEqual(first);
    expect(first).toEqual(expect.objectContaining({
      seed: 8675309,
      sampleSize: 3,
      guided: { passed: 3, failed: 0, passRate: 1 },
      direct: { passed: 1, failed: 2, passRate: 1 / 3 },
      interpretation: 'descriptive_only',
    }));
    expect(first.delta).toBeCloseTo(2 / 3);
    expect(first.cases.map((item) => item.question)).toEqual(queries.map((item) => item.question));
    expect(first.output).toContain('sample size 3');
    expect(first.output).toContain('Guided: 3/3 (100.00%)');
    expect(first.output).toContain('direct: 1/3 (33.33%)');
    expect(first.output).toContain('delta +66.67 percentage points');
    expect(first.output).toContain('does not establish statistical significance');

    const firstRunCalls = calls.slice(0, queries.length * 2);
    for (let index = 0; index < queries.length; index += 1) {
      const guidedCall = firstRunCalls[index * 2];
      const directCall = firstRunCalls[index * 2 + 1];
      expect(guidedCall.request).toMatchObject({
        seed: 8675309,
        mode: 'guided',
        question: queries[index].question,
        caseIndex: index,
      });
      expect(directCall.request).toMatchObject({
        seed: 8675309,
        mode: 'direct',
        question: queries[index].question,
        caseIndex: index,
      });
      expect(guidedCall.prompt).toContain('## Visible semantic schema');
      expect(guidedCall.prompt).not.toContain(queries[index].sql);
      expect(directCall.prompt).toBe(queries[index].question);
    }
  }, 60_000);

  it('rejects an empty golden set or invalid seed', async () => {
    const queries = project.queries;
    const base = {
      dialect: 'postgres' as const,
      client: { generate: async () => 'SELECT 1' },
      guided: { semantic, project },
    };
    await expect(runPromptBenchmark(database, [], { ...base, seed: 1 }))
      .rejects.toThrow('at least one golden query');
    await expect(runPromptBenchmark(database, queries, { ...base, seed: -1 }))
      .rejects.toThrow('non-negative safe integer');
  });
});
