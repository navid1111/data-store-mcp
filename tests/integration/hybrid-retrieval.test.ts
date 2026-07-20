import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionMemoryIndex } from '../../src/memory/index.js';
import {
  HybridMemoryRetriever,
  type EmbeddingProvider,
} from '../../src/memory/retrieval.js';

let directory: string;
let index: ExecutionMemoryIndex;
let retriever: HybridMemoryRetriever;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'data-store-mcp-hybrid-'));
  index = await ExecutionMemoryIndex.open(directory);
  await Promise.all([
    remember('Find rows in the performer-film junction', 'SELECT actor_id, film_id FROM film_actor'),
    remember('List customers who rented titles', 'SELECT customer_id FROM rental'),
    remember('Summarize revenue by store', 'SELECT store_id, SUM(amount) FROM payment GROUP BY store_id'),
  ]);
  // Fixed semantic mapping: deterministic equivalent of a fixed embedding seed.
  retriever = new HybridMemoryRetriever(index, new FixtureEmbeddings(17));
});

afterAll(async () => {
  index.close();
  await rm(directory, { recursive: true, force: true });
});

describe('hybrid execution-memory retrieval', () => {
  it('uses BM25 to recover an exact table identifier that vector-only misses', async () => {
    const hybrid = await retriever.search('film_actor');
    const vectorOnly = await retriever.search('film_actor', { lexical: false });

    expect(hybrid[0].record.sql).toContain('FROM film_actor');
    expect(hybrid[0].components.bm25).toEqual(expect.objectContaining({ rank: 1 }));
    expect(hybrid[0].score).toBeGreaterThan(0);
    expect(vectorOnly[0].record.sql).toContain('FROM rental');
  });

  it('uses vectors to recover a paraphrase with no lexical overlap', async () => {
    const query = 'connection between performers and movies';
    const hybrid = await retriever.search(query);
    const lexicalOnly = await retriever.search(query, { vector: false });

    expect(hybrid[0].record.sql).toContain('FROM film_actor');
    expect(hybrid[0].components.vector).toEqual(expect.objectContaining({ rank: 1 }));
    expect(lexicalOnly).toEqual([]);
  });

  it('produces deterministic RRF top-k rankings with component scores', async () => {
    const first = await retriever.search('film_actor', { limit: 2, rankConstant: 60 });
    const second = await retriever.search('film_actor', { limit: 2, rankConstant: 60 });

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(first[0]).toEqual(expect.objectContaining({
      score: expect.any(Number),
      components: expect.objectContaining({
        bm25: expect.objectContaining({ score: expect.any(Number), rank: expect.any(Number) }),
        vector: expect.objectContaining({ score: expect.any(Number), rank: expect.any(Number) }),
      }),
    }));
  });
});

async function remember(question: string, sql: string): Promise<void> {
  await index.recordExecution({ success: true, question, sql, rows: [], durationMs: 1 });
}

class FixtureEmbeddings implements EmbeddingProvider {
  constructor(private readonly seed: number) {}

  async embed(text: string): Promise<readonly number[]> {
    const normalized = text.toLowerCase();
    // The seed participates in the deterministic scale without changing cosine direction.
    const scale = this.seed / 17;
    if (normalized.trim() === 'film_actor') return [scale, 0, 0];
    if (normalized.includes('connection between performers and movies')) return [0, scale, 0];
    if (normalized.includes('film_actor') || normalized.includes('performer-film')) return [0, scale, 0];
    if (normalized.includes('customer') || normalized.includes('rental')) return [scale, 0, 0];
    return [0, 0, scale];
  }
}
