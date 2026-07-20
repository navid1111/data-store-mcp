/** MDL-backed identifier resolution and safe did-you-mean suggestions. */

import { unknownColumn, unknownTable } from '../governance/errors.js';
import type { SemanticRegistry } from './registry.js';
import type { Column, Model } from './types.js';

export interface SuggestionOptions {
    limit?: number;
    /** Names omitted by CLAC. They must not be observable through suggestions. */
    hidden?: ReadonlySet<string>;
}

export function suggestNames(
    input: string,
    candidates: readonly string[],
    options: SuggestionOptions = {},
): string[] {
    const limit = options.limit ?? 3;
    if (!Number.isInteger(limit) || limit < 0) {
        throw new RangeError(`Suggestion limit must be a non-negative integer, got ${limit}.`);
    }
    const normalized = input.toLocaleLowerCase();
    const threshold = maximumUsefulDistance(normalized.length);

    return [...new Set(candidates)]
        .filter((candidate) => !options.hidden?.has(candidate))
        .map((candidate) => ({
            candidate,
            distance: editDistance(normalized, candidate.toLocaleLowerCase()),
        }))
        .filter((item) => item.distance <= threshold)
        .sort((left, right) =>
            left.distance - right.distance || left.candidate.localeCompare(right.candidate))
        .slice(0, limit)
        .map((item) => item.candidate);
}

export function resolveModel(
    registry: SemanticRegistry,
    name: string,
    options: SuggestionOptions = {},
): Model {
    const model = registry.getModel(name);
    if (model && !options.hidden?.has(name)) return model;
    throw unknownTable(name, suggestNames(
        name,
        registry.document.models.map((candidate) => candidate.name),
        options,
    ));
}

export function resolveColumn(
    model: Model,
    name: string,
    options: SuggestionOptions = {},
): Column {
    const column = model.columns.find((candidate) => candidate.name === name);
    if (column && !options.hidden?.has(name)) return column;
    throw unknownColumn(name, suggestNames(
        name,
        model.columns.map((candidate) => candidate.name),
        options,
    ));
}

/** Optimal-string-alignment distance: adjacent transpositions cost one edit. */
export function editDistance(left: string, right: string): number {
    const rows = left.length + 1;
    const columns = right.length + 1;
    const matrix = Array.from({ length: rows }, () => Array<number>(columns).fill(0));
    for (let row = 0; row < rows; row += 1) matrix[row][0] = row;
    for (let column = 0; column < columns; column += 1) matrix[0][column] = column;

    for (let row = 1; row < rows; row += 1) {
        for (let column = 1; column < columns; column += 1) {
            const cost = left[row - 1] === right[column - 1] ? 0 : 1;
            matrix[row][column] = Math.min(
                matrix[row - 1][column] + 1,
                matrix[row][column - 1] + 1,
                matrix[row - 1][column - 1] + cost,
            );
            if (
                row > 1 && column > 1 &&
                left[row - 1] === right[column - 2] &&
                left[row - 2] === right[column - 1]
            ) {
                matrix[row][column] = Math.min(
                    matrix[row][column],
                    matrix[row - 2][column - 2] + 1,
                );
            }
        }
    }
    return matrix[left.length][right.length];
}

function maximumUsefulDistance(length: number): number {
    if (length <= 2) return 1;
    if (length <= 5) return 2;
    return Math.min(4, Math.ceil(length / 3));
}
