/** Conservative relationship inference for SQL sources without declared FKs. */

import type {
    ColumnInfo,
    Database,
    DatabaseType,
    Row,
    TableInfo,
    TableRelation,
} from '../database-source.js';
import {
    assertValidIdentifier,
    quoteMysqlIdentifier,
    quotePostgresIdentifier,
} from '../identifiers.js';
import type { Relationship } from './types.js';

export interface RelationshipInferenceEvidence {
    nameConvention: true;
    typeCompatible: true;
    sampledValues: number;
    overlappingValues: number;
    overlapRatio: number;
}

/** A reviewable proposal, deliberately distinct from a declared MDL relationship. */
export interface RelationshipCandidate extends Relationship {
    confidence: number;
    evidence: RelationshipInferenceEvidence;
}

export interface RelationshipInferenceOptions {
    /** Maximum number of distinct child-side values checked. Default 1,000. */
    sampleSize?: number;
    /** Minimum fraction of sampled child values found in the parent. Default 0.5. */
    minimumOverlapRatio?: number;
}

interface CandidatePair {
    childTable: TableInfo;
    childColumn: ColumnInfo;
    parentTable: TableInfo;
    parentColumn: ColumnInfo;
}

/**
 * Applies the R3.9 evidence pipeline in order: name convention, compatible
 * types, then a bounded value-overlap query. No candidate bypasses a stage.
 */
export async function inferRelationships(
    database: Database,
    options: RelationshipInferenceOptions = {},
): Promise<RelationshipCandidate[]> {
    if (database.config.type === 'mongodb') return [];
    const sampleSize = options.sampleSize ?? 1_000;
    const minimumOverlapRatio = options.minimumOverlapRatio ?? 0.5;
    validateOptions(sampleSize, minimumOverlapRatio);

    const tables = (await database.listTables())
        .filter((table) => table.kind === 'table')
        .sort((left, right) => left.name.localeCompare(right.name));
    const tableNames = new Set(tables.map((table) => table.name));
    const columns = (await database.getSchema())
        .filter((column) => tableNames.has(column.table));
    const declared = await database.getRelations();
    const declaredKeys = new Set(declared.map(relationKey));
    const pairs = candidatePairs(tables, columns, declaredKeys);
    const candidates: RelationshipCandidate[] = [];

    for (const pair of pairs) {
        const overlap = await sampleOverlap(database, pair, sampleSize);
        if (overlap.sampledValues === 0 || overlap.overlapRatio < minimumOverlapRatio) continue;
        // Even perfect sampled overlap stays below 1: inference is evidence,
        // not a declared constraint or human verification.
        const confidence = round(0.6 + (0.35 * overlap.overlapRatio));
        const percent = round(overlap.overlapRatio * 100);
        candidates.push({
            name: `${pair.childTable.name}_${pair.parentTable.name}_${pair.childColumn.name}_candidate`,
            description: `Inferred candidate: naming and types match; ${percent}% of sampled values overlap.`,
            provenance: 'profiling',
            verified: false,
            fromModel: pair.childTable.name,
            toModel: pair.parentTable.name,
            cardinality: 'many-to-one',
            joinKeys: [{
                fromColumn: pair.childColumn.name,
                toColumn: pair.parentColumn.name,
            }],
            confidence,
            evidence: {
                nameConvention: true,
                typeCompatible: true,
                ...overlap,
            },
        });
    }

    return candidates.sort((left, right) =>
        right.confidence - left.confidence || left.name.localeCompare(right.name));
}

function candidatePairs(
    tables: TableInfo[],
    columns: ColumnInfo[],
    declared: Set<string>,
): CandidatePair[] {
    const byTable = new Map<string, ColumnInfo[]>();
    for (const column of columns) {
        const existing = byTable.get(column.table) ?? [];
        existing.push(column);
        byTable.set(column.table, existing);
    }

    const output: CandidatePair[] = [];
    for (const parentTable of tables) {
        const parentColumns = (byTable.get(parentTable.name) ?? [])
            .filter((column) => column.isPrimaryKey || column.isUnique);
        for (const parentColumn of parentColumns) {
            for (const childTable of tables) {
                if (childTable.name === parentTable.name) continue;
                for (const childColumn of byTable.get(childTable.name) ?? []) {
                    if (!matchesNameConvention(childColumn.name, parentTable.name, parentColumn.name)) continue;
                    if (!compatibleTypes(childColumn.dataType, parentColumn.dataType)) continue;
                    if (declared.has(pairKey(
                        childTable.name,
                        childColumn.name,
                        parentTable.name,
                        parentColumn.name,
                    ))) continue;
                    output.push({ childTable, childColumn, parentTable, parentColumn });
                }
            }
        }
    }
    return output;
}

function matchesNameConvention(childColumn: string, parentTable: string, parentColumn: string): boolean {
    const child = childColumn.toLowerCase();
    const parent = parentTable.toLowerCase();
    const target = parentColumn.toLowerCase();
    return child === target && target === `${singular(parent)}_id`;
}

export function compatibleTypes(left: string, right: string): boolean {
    const normalizedLeft = normalizeType(left);
    const normalizedRight = normalizeType(right);
    return normalizedLeft === normalizedRight || typeFamily(normalizedLeft) === typeFamily(normalizedRight);
}

function normalizeType(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\(.+\)$/, '');
}

function typeFamily(value: string): string {
    if (/^(smallint|integer|bigint|tinyint|mediumint|int|int2|int4|int8|smallserial|serial|bigserial)$/.test(value)) {
        return 'integer';
    }
    if (/^(numeric|decimal|real|double precision|double|float|money)$/.test(value)) return 'numeric';
    if (/^(character varying|varchar|character|char|text|nvarchar|nchar)$/.test(value)) return 'text';
    return `exact:${value}`;
}

function singular(value: string): string {
    return value.endsWith('ies')
        ? `${value.slice(0, -3)}y`
        : value.endsWith('s') && !value.endsWith('ss')
            ? value.slice(0, -1)
            : value;
}

async function sampleOverlap(
    database: Database,
    pair: CandidatePair,
    sampleSize: number,
): Promise<Pick<RelationshipInferenceEvidence, 'sampledValues' | 'overlappingValues' | 'overlapRatio'>> {
    const quote = quoter(database.config.type);
    const childTable = qualifiedTable(pair.childTable, quote);
    const parentTable = qualifiedTable(pair.parentTable, quote);
    const childColumn = quote(pair.childColumn.name, 'column name');
    const parentColumn = quote(pair.parentColumn.name, 'column name');
    const sample = database.config.type === 'sqlserver'
        ? `SELECT DISTINCT TOP (${sampleSize}) c.${childColumn} AS value
           FROM ${childTable} c
           WHERE c.${childColumn} IS NOT NULL
           ORDER BY c.${childColumn}`
        : `SELECT DISTINCT c.${childColumn} AS value
           FROM ${childTable} c
           WHERE c.${childColumn} IS NOT NULL
           ORDER BY c.${childColumn}
           LIMIT ${sampleSize}`;
    const rows = rowsOf(await database.query(`
        SELECT
            count(*) AS sampled_values,
            COALESCE(sum(CASE WHEN p.${parentColumn} IS NULL THEN 0 ELSE 1 END), 0) AS overlapping_values
        FROM (${sample}) sampled
        LEFT JOIN ${parentTable} p ON p.${parentColumn} = sampled.value
    `));
    const sampledValues = numeric(rows[0]?.sampled_values);
    const overlappingValues = numeric(rows[0]?.overlapping_values);
    return {
        sampledValues,
        overlappingValues,
        overlapRatio: sampledValues === 0 ? 0 : overlappingValues / sampledValues,
    };
}

type Quote = (value: unknown, kind?: string) => string;

function quoter(type: DatabaseType): Quote {
    if (type === 'mysql') return quoteMysqlIdentifier;
    if (type === 'sqlserver') {
        return (value, kind = 'identifier') => `[${assertValidIdentifier(value, kind)}]`;
    }
    return quotePostgresIdentifier;
}

function qualifiedTable(table: TableInfo, quote: Quote): string {
    const name = quote(table.name, 'table name');
    return table.schema ? `${quote(table.schema, 'schema name')}.${name}` : name;
}

function relationKey(relation: TableRelation): string {
    return pairKey(relation.childTable, relation.childColumn, relation.parentTable, relation.parentColumn);
}

function pairKey(childTable: string, childColumn: string, parentTable: string, parentColumn: string): string {
    return `${childTable}.${childColumn}->${parentTable}.${parentColumn}`.toLowerCase();
}

function rowsOf(value: unknown): Row[] {
    if (!Array.isArray(value)) throw new Error('Relationship overlap query returned a non-row result.');
    return value.filter((row): row is Row => Boolean(row && typeof row === 'object' && !Array.isArray(row)));
}

function numeric(value: unknown): number {
    const result = Number(value ?? 0);
    if (!Number.isFinite(result) || result < 0) {
        throw new Error(`Relationship overlap query returned an invalid count: ${String(value)}.`);
    }
    return result;
}

function validateOptions(sampleSize: number, minimumOverlapRatio: number): void {
    if (!Number.isInteger(sampleSize) || sampleSize < 1 || sampleSize > 10_000) {
        throw new RangeError(`sampleSize must be an integer from 1 to 10000, got ${sampleSize}.`);
    }
    if (!Number.isFinite(minimumOverlapRatio) || minimumOverlapRatio <= 0 || minimumOverlapRatio > 1) {
        throw new RangeError(
            `minimumOverlapRatio must be greater than 0 and at most 1, got ${minimumOverlapRatio}.`,
        );
    }
}

function round(value: number): number {
    return Math.round(value * 10_000) / 10_000;
}
