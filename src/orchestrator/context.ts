/** Version-controlled business context loading (spec R4.1/R4.2). */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import { z, type ZodIssue } from 'zod';

export interface ApprovedQuery {
    question: string;
    sql: string;
}

export interface ProjectContext {
    instructions: string;
    queries: ApprovedQuery[];
}

export class ContextFileError extends Error {
    readonly file: string;
    readonly line: number;
    readonly column: number;

    constructor(file: string, line: number, column: number, detail: string) {
        super(`${file}:${line}:${column}: ${detail}`);
        this.name = 'ContextFileError';
        this.file = file;
        this.line = line;
        this.column = column;
    }
}

const nonEmpty = z.string().trim().min(1);
const queriesSchema = z.object({
    queries: z.array(z.object({
        question: nonEmpty,
        sql: nonEmpty,
    }).strict()).default([]),
}).strict();

/** Missing context files are an intentionally valid empty project context. */
export async function loadProjectContext(directory: string): Promise<ProjectContext> {
    const instructionsPath = join(directory, 'instructions.md');
    const queriesPath = join(directory, 'queries.yml');
    const [instructions, querySource] = await Promise.all([
        readOptional(instructionsPath),
        readOptional(queriesPath),
    ]);
    return {
        instructions: instructions ?? '',
        queries: querySource === undefined ? [] : parseQueriesYaml(querySource, queriesPath),
    };
}

/** Strict, located parser exported for evaluation and promotion workflows. */
export function parseQueriesYaml(source: string, file = 'queries.yml'): ApprovedQuery[] {
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
        throw new ContextFileError(file, position.line, position.col, error.message);
    }

    const parsed = queriesSchema.safeParse(document.toJS());
    if (parsed.success) return parsed.data.queries;
    const issue = parsed.error.issues[0];
    const path = issuePath(issue);
    const node = nearestNode(document, path);
    const position = lineCounter.linePos(node?.range?.[0] ?? 0);
    const label = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    throw new ContextFileError(file, position.line, position.col, `${label}${issue.message}`);
}

async function readOptional(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

function issuePath(issue: ZodIssue): Array<string | number> {
    return issue.code === 'unrecognized_keys'
        ? [...issue.path, issue.keys[0]]
        : [...issue.path];
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
