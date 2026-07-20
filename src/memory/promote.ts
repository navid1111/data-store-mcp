/** Explicit promotion of successful executions into reviewable golden context. */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stringify } from 'yaml';
import { parseQueriesYaml, type ApprovedQuery } from '../orchestrator/context.js';

export interface QueryPromotionInput {
    approved: boolean;
    question: string;
    sql: string;
    expected: readonly Record<string, unknown>[];
}

export interface QueryPromotionResult {
    changed: boolean;
    total: number;
}

/**
 * Appends one approved golden case without parsing and re-emitting existing
 * content, so comments and formatting already under review remain untouched.
 */
export async function promoteQuery(
    path: string,
    input: QueryPromotionInput,
): Promise<QueryPromotionResult> {
    if (input.approved !== true) {
        throw new Error('Query promotion requires explicit approved: true.');
    }
    const existingSource = await readFile(path, 'utf8').catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    });
    const source = existingSource ?? 'queries:\n';
    const existing = parseQueriesYaml(source, path);
    const question = input.question.trim();
    const sql = input.sql.trim();
    if (!question) throw new Error('Promoted question must not be empty.');
    if (!sql) throw new Error('Promoted SQL must not be empty.');

    const duplicate = existing.find((query) => query.question === question);
    const promoted: ApprovedQuery = {
        question,
        sql,
        expected: input.expected.map((row) => ({ ...row })),
    };
    if (duplicate) {
        if (sameQuery(duplicate, promoted)) return { changed: false, total: existing.length };
        throw new Error(`queries.yml already contains a different entry for question: ${question}`);
    }
    if (/^queries:\s*\[\s*\]\s*$/m.test(source)) {
        throw new Error('Cannot append without reformatting inline "queries: []"; use block form "queries:".');
    }

    const fragment = renderFragment(promoted);
    const separator = source.endsWith('\n') ? '' : '\n';
    const addition = `${separator}${fragment}`;
    // Validate the exact future file before any write occurs.
    parseQueriesYaml(`${source}${addition}`, path);
    if (existingSource === undefined) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${source}${addition}`, 'utf8');
    } else {
        await appendFile(path, addition, 'utf8');
    }
    return { changed: true, total: existing.length + 1 };
}

function renderFragment(query: ApprovedQuery): string {
    const rendered = stringify({ queries: [query] }, { indent: 2, lineWidth: 0 });
    return rendered.slice(rendered.indexOf('\n') + 1);
}

function sameQuery(left: ApprovedQuery, right: ApprovedQuery): boolean {
    return left.sql === right.sql && JSON.stringify(left.expected) === JSON.stringify(right.expected);
}
