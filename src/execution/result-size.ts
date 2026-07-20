/** Incremental serialized-result byte accounting (spec R1.4). */

import { resultTooLarge } from '../governance/errors.js';
import type { ExecuteOptions } from '../governance/plan.js';

export const DEFAULT_MAX_RESULT_BYTES = 10 * 1024 * 1024;

export function resolveMaxBytes(options?: ExecuteOptions): number {
    const value = options?.maxBytes ?? DEFAULT_MAX_RESULT_BYTES;
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`maxBytes must be a positive integer, got ${value}`);
    }
    return value;
}

/**
 * Builds a JSON-array result one row at a time and throws as soon as its exact
 * UTF-8 serialization crosses the cap. Rows after the crossing point are never
 * retained in memory.
 */
export class ResultByteAccumulator<T> {
    private readonly values: T[] = [];
    private bytes = 2; // opening and closing brackets

    constructor(private readonly limit: number) {
        if (this.bytes > limit) throw resultTooLarge(limit, this.bytes);
    }

    add(value: T): void {
        const serialized = JSON.stringify(value) ?? 'null';
        this.bytes += Buffer.byteLength(serialized, 'utf8');
        if (this.values.length > 0) this.bytes += 1; // comma

        if (this.bytes > this.limit) {
            throw resultTooLarge(this.limit, this.bytes);
        }
        this.values.push(value);
    }

    result(): T[] {
        return this.values;
    }

    serializedBytes(): number {
        return this.bytes;
    }
}

/** Applies the same exact accounting to scalar and already-atomic results. */
export function enforceValueByteLimit<T>(value: T, limit: number): T {
    const serialized = JSON.stringify(value) ?? 'null';
    const actual = Buffer.byteLength(serialized, 'utf8');
    if (actual > limit) throw resultTooLarge(limit, actual);
    return value;
}
