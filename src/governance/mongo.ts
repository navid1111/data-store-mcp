/**
 * Governance gate for caller-supplied MongoDB queries (spec R1.6).
 *
 * Mongo bypasses the SQL parser, but it does not bypass governance. External
 * input is validated here, write operations and write pipeline stages are
 * refused, and result-producing operations receive a server-side limit before
 * an adapter can execute them.
 */

import type { Document, Filter } from 'mongodb';
import { policyDenied, writeForbidden } from './errors.js';

export type MongoReadOperation =
    | 'find'
    | 'findOne'
    | 'aggregate'
    | 'countDocuments'
    | 'distinct';

export interface MongoQueryPayload {
    operation: MongoReadOperation;
    collection: string;
    filter?: Filter<Document>;
    projection?: Document;
    sort?: Document;
    limit?: number;
    skip?: number;
    pipeline?: Document[];
    field?: string;
}

declare const MONGO_QUERY_PLAN_BRAND: unique symbol;

/** The only MongoDB payload an adapter will execute. */
export interface MongoQueryPlan {
    readonly payload: Readonly<MongoQueryPayload>;
    /** null for operations such as countDocuments that have no row-limit concept. */
    readonly appliedLimit: number | null;
    readonly appliedPolicies: readonly string[];
    readonly [MONGO_QUERY_PLAN_BRAND]: true;
}

export interface MongoGateOptions {
    /** Limit applied when the caller omitted one. */
    defaultLimit?: number;
    /** Caller limits above this value are clamped. */
    maxLimit?: number;
    /** Maximum number of stages supplied by the caller, before the policy limit. */
    maxPipelineStages?: number;
}

export const DEFAULT_MONGO_LIMIT = 1_000;
export const MAX_MONGO_LIMIT = 10_000;
export const MAX_MONGO_PIPELINE_STAGES = 50;

const READ_OPERATIONS = new Set<MongoReadOperation>([
    'find',
    'findOne',
    'aggregate',
    'countDocuments',
    'distinct',
]);

const WRITE_STAGES = new Set(['$out', '$merge']);

/**
 * Validates and rewrites a MongoDB query into an immutable executable plan.
 *
 * @throws GovernanceError — E_WRITE_FORBIDDEN or E_POLICY_DENIED
 */
export function buildMongoPlan(
    input: unknown,
    options: MongoGateOptions = {},
): MongoQueryPlan {
    const defaultLimit = positiveInteger(
        options.defaultLimit ?? DEFAULT_MONGO_LIMIT,
        'defaultLimit',
    );
    const maxLimit = positiveInteger(options.maxLimit ?? MAX_MONGO_LIMIT, 'maxLimit');
    const maxPipelineStages = positiveInteger(
        options.maxPipelineStages ?? MAX_MONGO_PIPELINE_STAGES,
        'maxPipelineStages',
    );

    if (defaultLimit > maxLimit) {
        throw policyDenied(
            'mongo-limit',
            `MongoDB defaultLimit (${defaultLimit}) cannot exceed maxLimit (${maxLimit}).`,
        );
    }

    const raw = parseInput(input);
    const operation = requiredString(raw.operation, 'operation');

    if (!READ_OPERATIONS.has(operation as MongoReadOperation)) {
        throw writeForbidden(
            operation,
            `MongoDB operation "${operation}" is not in the read-only allowlist.`,
        );
    }

    const collection = requiredString(raw.collection, 'collection');
    const payload = clonePayload(raw, operation as MongoReadOperation, collection);
    let appliedLimit: number | null = null;
    const appliedPolicies = ['mongo-read-only'];

    switch (payload.operation) {
        case 'find': {
            const requested = optionalPositiveInteger(payload.limit, 'limit');
            appliedLimit = Math.min(requested ?? defaultLimit, maxLimit);
            payload.limit = appliedLimit;
            appliedPolicies.push(`mongo-limit:${appliedLimit}`);
            break;
        }
        case 'findOne':
            appliedLimit = 1;
            appliedPolicies.push('mongo-limit:1');
            break;
        case 'aggregate': {
            const pipeline = validatePipeline(payload.pipeline, maxPipelineStages);
            const requestedLimits = pipeline
                .filter((stage) => stage.$limit !== undefined)
                .map((stage) => positiveInteger(stage.$limit, '$limit'));
            appliedLimit = Math.min(
                requestedLimits.length ? Math.min(...requestedLimits) : defaultLimit,
                maxLimit,
            );
            const finalStage = pipeline[pipeline.length - 1];
            if (finalStage?.$limit !== undefined) {
                finalStage.$limit = appliedLimit;
            } else {
                pipeline.push({ $limit: appliedLimit });
            }

            payload.pipeline = pipeline;
            appliedPolicies.push(`mongo-limit:${appliedLimit}`);
            appliedPolicies.push(`mongo-pipeline-stages:${maxPipelineStages}`);
            break;
        }
        case 'distinct':
            if (!payload.field || typeof payload.field !== 'string') {
                throw policyDenied(
                    'mongo-query-shape',
                    'MongoDB distinct queries require a field with a non-empty name.',
                );
            }
            break;
        case 'countDocuments':
            // Counts return one scalar and MongoDB exposes no cursor limit for them.
            break;
    }

    const plan = {
        payload: deepFreeze(payload),
        appliedLimit,
        appliedPolicies: Object.freeze(appliedPolicies),
    };

    // The brand is type-only, just like the SQL QueryPlan brand.
    return Object.freeze(plan) as MongoQueryPlan;
}

function parseInput(input: unknown): Record<string, unknown> {
    let parsed = input;
    if (typeof input === 'string') {
        try {
            parsed = JSON.parse(input);
        } catch (error) {
            throw policyDenied(
                'mongo-query-shape',
                `MongoDB query must be valid JSON: ${(error as Error).message}`,
            );
        }
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw policyDenied('mongo-query-shape', 'MongoDB query must be an object.');
    }
    return parsed as Record<string, unknown>;
}

function clonePayload(
    raw: Record<string, unknown>,
    operation: MongoReadOperation,
    collection: string,
): MongoQueryPayload {
    return {
        operation,
        collection,
        ...(raw.filter !== undefined ? { filter: cloneDocument(raw.filter, 'filter') } : {}),
        ...(raw.projection !== undefined
            ? { projection: cloneDocument(raw.projection, 'projection') }
            : {}),
        ...(raw.sort !== undefined ? { sort: cloneDocument(raw.sort, 'sort') } : {}),
        ...(raw.limit !== undefined ? { limit: raw.limit as number } : {}),
        ...(raw.skip !== undefined
            ? { skip: optionalNonNegativeInteger(raw.skip, 'skip') }
            : {}),
        ...(raw.pipeline !== undefined
            ? { pipeline: clonePipeline(raw.pipeline) }
            : {}),
        ...(raw.field !== undefined ? { field: raw.field as string } : {}),
    };
}

function cloneDocument(value: unknown, field: string): Document {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw policyDenied('mongo-query-shape', `MongoDB ${field} must be an object.`);
    }
    return structuredClone(value) as Document;
}

function clonePipeline(value: unknown): Document[] {
    if (!Array.isArray(value)) {
        throw policyDenied('mongo-query-shape', 'MongoDB aggregate pipeline must be an array.');
    }
    return value.map((stage, index) => cloneDocument(stage, `pipeline stage ${index}`));
}

function validatePipeline(pipeline: Document[] | undefined, maxStages: number): Document[] {
    const stages = pipeline ?? [];
    if (stages.length > maxStages) {
        throw policyDenied(
            'mongo-pipeline-stages',
            `MongoDB aggregate pipeline has ${stages.length} stages; maximum is ${maxStages}.`,
        );
    }

    for (const [index, stage] of stages.entries()) {
        const keys = Object.keys(stage);
        if (keys.length !== 1 || !keys[0].startsWith('$')) {
            throw policyDenied(
                'mongo-query-shape',
                `MongoDB pipeline stage ${index} must contain exactly one stage operator.`,
            );
        }

        const writeStage = findWriteStage(stage);
        if (writeStage) {
            throw writeForbidden(
                writeStage,
                `${writeStage} writes aggregate results and is forbidden on a read-only source.`,
            );
        }
    }

    return stages;
}

/** Finds forbidden stages even in nested pipelines such as $facet/$lookup. */
function findWriteStage(value: unknown): string | undefined {
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findWriteStage(item);
            if (found) return found;
        }
        return undefined;
    }
    if (!value || typeof value !== 'object') return undefined;

    for (const [key, nested] of Object.entries(value)) {
        if (WRITE_STAGES.has(key)) return key;
        const found = findWriteStage(nested);
        if (found) return found;
    }
    return undefined;
}

function requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
        throw policyDenied(
            'mongo-query-shape',
            `MongoDB query requires a non-empty ${field}.`,
        );
    }
    return value;
}

function positiveInteger(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw policyDenied(
            'mongo-query-shape',
            `MongoDB ${field} must be a positive integer.`,
        );
    }
    return value;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
    return value === undefined ? undefined : positiveInteger(value, field);
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw policyDenied(
            'mongo-query-shape',
            `MongoDB ${field} must be a non-negative integer.`,
        );
    }
    return value;
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const nested of Object.values(value)) deepFreeze(nested);
    }
    return value;
}
