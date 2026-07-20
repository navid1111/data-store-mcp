/** Golden query evaluation with deterministic, order-aware result comparison. */

import type { Database, Row } from '../database-source.js';
import { buildPlan } from '../governance/gate.js';
import { parseSql, type Dialect, type Statement } from '../governance/parse.js';
import type { ApprovedQuery } from '../orchestrator/context.js';

export interface GoldenEvalOptions {
    dialect: Dialect;
    /** Required passing fraction, from 0 through 1. Default 1. */
    threshold?: number;
}

export interface GoldenCaseResult {
    question: string;
    status: 'passed' | 'failed';
    ordered: boolean;
    message?: string;
}

export interface GoldenEvalReport {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    threshold: number;
    exitCode: 0 | 1;
    cases: GoldenCaseResult[];
    output: string;
}

export async function runGoldenEval(
    database: Database,
    queries: readonly ApprovedQuery[],
    options: GoldenEvalOptions,
): Promise<GoldenEvalReport> {
    const threshold = options.threshold ?? 1;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        throw new RangeError(`threshold must be between 0 and 1, got ${threshold}.`);
    }

    const cases: GoldenCaseResult[] = [];
    for (const query of queries) {
        let ordered = false;
        try {
            ordered = hasOrderBy(query.sql, options.dialect);
        } catch (error) {
            cases.push({
                question: query.question,
                status: 'failed',
                ordered,
                message: `Execution failed: ${(error as Error).message}`,
            });
            continue;
        }
        if (!query.expected) {
            cases.push({
                question: query.question,
                status: 'failed',
                ordered,
                message: 'No expected result is recorded.',
            });
            continue;
        }
        try {
            const plan = buildPlan(query.sql, {
                dialect: options.dialect,
                defaultLimit: 10_000,
                maxLimit: 10_000,
            });
            const actual = rowsOf(await database.execute(plan));
            const comparison = compareRows(actual, query.expected, ordered);
            cases.push({
                question: query.question,
                status: comparison.equal ? 'passed' : 'failed',
                ordered,
                ...(!comparison.equal ? { message: comparison.message } : {}),
            });
        } catch (error) {
            cases.push({
                question: query.question,
                status: 'failed',
                ordered,
                message: `Execution failed: ${(error as Error).message}`,
            });
        }
    }

    const passed = cases.filter((item) => item.status === 'passed').length;
    const total = cases.length;
    const passRate = total === 0 ? 1 : passed / total;
    const report: Omit<GoldenEvalReport, 'output'> = {
        total,
        passed,
        failed: total - passed,
        passRate,
        threshold,
        exitCode: passRate >= threshold ? 0 : 1,
        cases,
    };
    return { ...report, output: formatGoldenEvalReport(report) };
}

export function formatGoldenEvalReport(report: Omit<GoldenEvalReport, 'output'>): string {
    const lines = [
        `Golden eval: ${report.passed}/${report.total} passed ` +
            `(${percent(report.passRate)}); threshold ${percent(report.threshold)}.`,
    ];
    for (const result of report.cases) {
        if (result.status === 'failed') {
            lines.push(`FAIL ${result.question}: ${result.message ?? 'result mismatch'}`);
        }
    }
    return `${lines.join('\n')}\n`;
}

function hasOrderBy(sql: string, dialect: Dialect): boolean {
    const parsed = parseSql(sql, dialect);
    return parsed.statements.some(statementHasOrderBy);
}

function statementHasOrderBy(statement: Statement): boolean {
    let current: Statement | undefined = statement;
    while (current) {
        if (Array.isArray(current.orderby) && current.orderby.length > 0) return true;
        current = current._next && typeof current._next === 'object'
            ? current._next as Statement
            : undefined;
    }
    return false;
}

function compareRows(
    actual: Row[],
    expected: Array<Record<string, unknown>>,
    ordered: boolean,
): { equal: boolean; message?: string } {
    const actualRows = actual.map(canonicalRow);
    const expectedRows = expected.map(canonicalRow);
    if (!ordered) {
        actualRows.sort();
        expectedRows.sort();
    }
    const equal = actualRows.length === expectedRows.length &&
        actualRows.every((row, index) => row === expectedRows[index]);
    return equal
        ? { equal: true }
        : {
            equal: false,
            message: `Result mismatch: expected ${expectedRows.length} row(s), got ${actualRows.length}.`,
        };
}

function canonicalRow(row: Record<string, unknown>): string {
    return JSON.stringify(normalize(row));
}

function normalize(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, normalize(nested)]));
    }
    return value;
}

function rowsOf(value: unknown): Row[] {
    if (!Array.isArray(value) || !value.every((row) =>
        Boolean(row && typeof row === 'object' && !Array.isArray(row)))) {
        throw new Error('Query returned a non-row result.');
    }
    return value as Row[];
}

function percent(value: number): string {
    return `${(value * 100).toFixed(2)}%`;
}
