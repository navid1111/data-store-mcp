/** Strict YAML schema and codec for MDL files. */

import { LineCounter, parseDocument, stringify } from 'yaml';
import { z, type ZodIssue } from 'zod';
import {
    PROVENANCE_VALUES,
    type MdlDocument,
} from './types.js';

const nonEmpty = z.string().trim().min(1);
const provenanceSchema = z.enum(PROVENANCE_VALUES);
const semanticScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const entityFields = {
    name: nonEmpty,
    // Description coverage is a lint rule (task 2.14), not a parse rule. An
    // empty draft must remain reviewable instead of crashing bootstrap.
    description: z.string(),
    provenance: provenanceSchema,
    // Unreviewed is the safe default. Only a human edit may opt into true.
    verified: z.boolean().default(false),
};

export const columnSchema = z.object({
    ...entityFields,
    dataType: nonEmpty,
    sourceColumn: nonEmpty.optional(),
    nullable: z.boolean().optional(),
    isPrimaryKey: z.boolean().optional(),
    isUnique: z.boolean().optional(),
    profile: z.object({
        distinctCount: z.number().int().nonnegative(),
        nullRate: z.number().min(0).max(1),
        min: semanticScalar.optional(),
        max: semanticScalar.optional(),
        topValues: z.array(z.object({
            value: semanticScalar,
            count: z.number().int().nonnegative(),
        }).strict()).optional(),
    }).strict().optional(),
}).strict();

export const modelSchema = z.object({
    ...entityFields,
    source: nonEmpty,
    table: nonEmpty,
    kind: z.enum(['table', 'view']).default('table'),
    columns: z.array(columnSchema).min(1),
}).strict();

export const relationshipSchema = z.object({
    ...entityFields,
    fromModel: nonEmpty,
    toModel: nonEmpty,
    cardinality: z.enum(['one-to-many', 'many-to-one', 'many-to-many']),
    joinKeys: z.array(z.object({
        fromColumn: nonEmpty,
        toColumn: nonEmpty,
    }).strict()).min(1),
    throughModel: nonEmpty.optional(),
}).strict();

export const metricSchema = z.object({
    ...entityFields,
    model: nonEmpty,
    expression: nonEmpty,
}).strict();

export const viewSchema = z.object({
    ...entityFields,
    model: nonEmpty,
    columns: z.array(nonEmpty).default([]),
    metrics: z.array(nonEmpty).default([]),
}).strict();

export const cubeSchema = z.object({
    ...entityFields,
    model: nonEmpty,
    dimensions: z.array(nonEmpty),
    measures: z.array(nonEmpty),
}).strict();

export const mdlDocumentSchema = z.object({
    models: z.array(modelSchema).default([]),
    relationships: z.array(relationshipSchema).default([]),
    metrics: z.array(metricSchema).default([]),
    views: z.array(viewSchema).default([]),
    cubes: z.array(cubeSchema).default([]),
}).strict();

export class MdlValidationError extends Error {
    readonly line: number;
    readonly column: number;
    readonly issues: readonly ZodIssue[];

    constructor(message: string, line: number, column: number, issues: readonly ZodIssue[] = []) {
        super(`${message} (line ${line}, column ${column})`);
        this.name = 'MdlValidationError';
        this.line = line;
        this.column = column;
        this.issues = issues;
    }
}

/** Parses one YAML MDL file, retaining a useful source position on failure. */
export function parseMdlYaml(source: string): MdlDocument {
    const lineCounter = new LineCounter();
    const document = parseDocument(source, {
        lineCounter,
        prettyErrors: true,
        strict: true,
        uniqueKeys: true,
    });

    if (document.errors.length > 0) {
        const error = document.errors[0];
        const position = error.linePos?.[0] ?? { line: 1, col: 1 };
        throw new MdlValidationError(error.message, position.line, position.col);
    }

    const result = mdlDocumentSchema.safeParse(document.toJS());
    if (result.success) return result.data satisfies MdlDocument;

    const issue = result.error.issues[0];
    const path = issuePath(issue);
    const node = nearestNode(document, path);
    const offset = node?.range?.[0] ?? 0;
    const position = lineCounter.linePos(offset);
    const label = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    throw new MdlValidationError(
        `${label}${issue.message}`,
        position.line,
        position.col,
        result.error.issues,
    );
}

/** Emits canonical, stable YAML after validating the in-memory document. */
export function stringifyMdlYaml(value: MdlDocument): string {
    const parsed = mdlDocumentSchema.parse(value);
    return stringify(parsed, { indent: 2, lineWidth: 0 });
}

function issuePath(issue: ZodIssue): Array<string | number> {
    if (issue.code === 'unrecognized_keys') {
        return [...issue.path, issue.keys[0]];
    }
    return [...issue.path];
}

function nearestNode(
    document: ReturnType<typeof parseDocument>,
    path: Array<string | number>,
): { range?: readonly number[] } | null | undefined {
    for (let length = path.length; length > 0; length -= 1) {
        const node = document.getIn(path.slice(0, length), true) as
            | { range?: readonly number[] }
            | null
            | undefined;
        if (node) return node;
    }
    return document.contents as { range?: readonly number[] } | null;
}
