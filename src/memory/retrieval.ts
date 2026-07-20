/** BM25 + vector retrieval fused with reciprocal rank fusion (spec R5.2). */

import type { ExecutionMemoryIndex, ExecutionMemoryRecord } from './index.js';

export interface EmbeddingProvider {
    embed(text: string): Promise<readonly number[]>;
}

export interface HybridSearchOptions {
    limit?: number;
    lexical?: boolean;
    vector?: boolean;
    /** RRF rank constant. Default 60. */
    rankConstant?: number;
}

export interface RankedComponent {
    rank: number;
    score: number;
}

export interface HybridSearchResult {
    record: ExecutionMemoryRecord;
    score: number;
    components: {
        bm25?: RankedComponent;
        vector?: RankedComponent;
    };
}

interface Scored {
    id: string;
    score: number;
}

export class HybridMemoryRetriever {
    constructor(
        private readonly index: ExecutionMemoryIndex,
        private readonly embeddings: EmbeddingProvider,
    ) {}

    async search(query: string, options: HybridSearchOptions = {}): Promise<HybridSearchResult[]> {
        const normalizedQuery = query.trim();
        if (!normalizedQuery) throw new Error('Search query must not be empty.');
        const limit = options.limit ?? 5;
        const rankConstant = options.rankConstant ?? 60;
        const lexicalEnabled = options.lexical ?? true;
        const vectorEnabled = options.vector ?? true;
        if (!Number.isInteger(limit) || limit < 1) {
            throw new RangeError(`limit must be a positive integer, got ${limit}.`);
        }
        if (!Number.isFinite(rankConstant) || rankConstant <= 0) {
            throw new RangeError(`rankConstant must be positive, got ${rankConstant}.`);
        }
        if (!lexicalEnabled && !vectorEnabled) {
            throw new Error('Hybrid search requires lexical, vector, or both.');
        }

        const records = await this.index.records();
        if (records.length === 0) return [];
        const documents = records.map((record) => ({
            id: record.id,
            text: documentText(record),
        }));
        const lexical = lexicalEnabled ? bm25(normalizedQuery, documents) : [];
        const vector = vectorEnabled
            ? await vectorScores(normalizedQuery, documents, this.embeddings)
            : [];
        return fuse(records, lexical, vector, { limit, rankConstant });
    }
}

function bm25(query: string, documents: Array<{ id: string; text: string }>): Scored[] {
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0) return [];
    const tokenized = documents.map((document) => ({ ...document, terms: tokenize(document.text) }));
    const averageLength = tokenized.reduce((sum, document) => sum + document.terms.length, 0) /
        Math.max(1, tokenized.length);
    const k1 = 1.2;
    const b = 0.75;
    const scores = tokenized.map((document) => {
        const frequencies = frequenciesOf(document.terms);
        const score = queryTerms.reduce((sum, term) => {
            const frequency = frequencies.get(term) ?? 0;
            if (frequency === 0) return sum;
            const containing = tokenized.filter((candidate) => candidate.terms.includes(term)).length;
            const idf = Math.log(1 + ((tokenized.length - containing + 0.5) / (containing + 0.5)));
            const lengthRatio = document.terms.length / Math.max(1, averageLength);
            return sum + idf * ((frequency * (k1 + 1)) /
                (frequency + k1 * (1 - b + (b * lengthRatio))));
        }, 0);
        return { id: document.id, score };
    });
    return ranked(scores.filter((item) => item.score > 0));
}

async function vectorScores(
    query: string,
    documents: Array<{ id: string; text: string }>,
    embeddings: EmbeddingProvider,
): Promise<Scored[]> {
    const [queryVector, ...documentVectors] = await Promise.all([
        embeddings.embed(query),
        ...documents.map((document) => embeddings.embed(document.text)),
    ]);
    validateVector(queryVector, 'query');
    const scores = documents.map((document, index) => {
        const vector = documentVectors[index];
        validateVector(vector, `document ${document.id}`, queryVector.length);
        return { id: document.id, score: cosine(queryVector, vector) };
    });
    return ranked(scores);
}

function fuse(
    records: ExecutionMemoryRecord[],
    lexical: Scored[],
    vector: Scored[],
    options: { limit: number; rankConstant: number },
): HybridSearchResult[] {
    const byId = new Map(records.map((record) => [record.id, record]));
    const lexicalRanks = ranks(lexical);
    const vectorRanks = ranks(vector);
    const ids = new Set([...lexicalRanks.keys(), ...vectorRanks.keys()]);
    return [...ids].map((id): HybridSearchResult => {
        const bm25Component = lexicalRanks.get(id);
        const vectorComponent = vectorRanks.get(id);
        const score = (bm25Component ? 1 / (options.rankConstant + bm25Component.rank) : 0) +
            (vectorComponent ? 1 / (options.rankConstant + vectorComponent.rank) : 0);
        return {
            record: byId.get(id)!,
            score,
            components: {
                ...(bm25Component ? { bm25: bm25Component } : {}),
                ...(vectorComponent ? { vector: vectorComponent } : {}),
            },
        };
    }).sort((left, right) =>
        right.score - left.score || left.record.id.localeCompare(right.record.id))
        .slice(0, options.limit);
}

function ranks(items: Scored[]): Map<string, RankedComponent> {
    return new Map(items.map((item, index) => [item.id, { rank: index + 1, score: item.score }]));
}

function ranked(items: Scored[]): Scored[] {
    return items.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function documentText(record: ExecutionMemoryRecord): string {
    return `${record.question}\n${record.sql}`;
}

function tokenize(value: string): string[] {
    return value.toLowerCase().match(/[a-z_][a-z0-9_]*|[0-9]+/g) ?? [];
}

function frequenciesOf(terms: string[]): Map<string, number> {
    const frequencies = new Map<string, number>();
    for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    return frequencies;
}

function validateVector(vector: readonly number[], label: string, length?: number): void {
    if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
        throw new Error(`Embedding for ${label} must be a non-empty finite vector.`);
    }
    if (length !== undefined && vector.length !== length) {
        throw new Error(`Embedding dimension mismatch for ${label}: expected ${length}, got ${vector.length}.`);
    }
}

function cosine(left: readonly number[], right: readonly number[]): number {
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < left.length; index += 1) {
        dot += left[index] * right[index];
        leftNorm += left[index] ** 2;
        rightNorm += right[index] ** 2;
    }
    if (leftNorm === 0 || rightNorm === 0) return 0;
    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
