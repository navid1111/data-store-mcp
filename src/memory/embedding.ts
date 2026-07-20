/** Dependency-free deterministic embeddings for local retrieval startup. */

import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from './retrieval.js';

export class HashEmbeddingProvider implements EmbeddingProvider {
    constructor(private readonly dimensions = 128) {
        if (!Number.isInteger(dimensions) || dimensions < 8) {
            throw new RangeError(`Embedding dimensions must be an integer of at least 8, got ${dimensions}.`);
        }
    }

    async embed(text: string): Promise<readonly number[]> {
        const vector = Array<number>(this.dimensions).fill(0);
        for (const token of text.toLowerCase().match(/[a-z_][a-z0-9_]*|[0-9]+/g) ?? []) {
            const digest = createHash('sha256').update(token).digest();
            const index = digest.readUInt32BE(0) % this.dimensions;
            vector[index] += (digest[4] & 1) === 0 ? 1 : -1;
        }
        return vector;
    }
}
