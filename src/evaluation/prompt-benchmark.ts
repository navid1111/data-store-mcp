/** Paired guided-vs-direct text-to-SQL benchmark (spec R7.2). */

import type { Database } from '../database-source.js';
import type { Dialect } from '../governance/parse.js';
import {
    askQuestion,
    type AskMode,
    type GuidedAskContext,
} from '../orchestrator/ask.js';
import type { ApprovedQuery } from '../orchestrator/context.js';
import { runGoldenEval } from './golden.js';

export interface BenchmarkGenerationRequest {
    seed: number;
    mode: AskMode;
    question: string;
    caseIndex: number;
}

export interface SeededPromptClient {
    generate(prompt: string, request: BenchmarkGenerationRequest): Promise<string>;
}

export interface PromptBenchmarkOptions {
    dialect: Dialect;
    seed: number;
    client: SeededPromptClient;
    guided: GuidedAskContext;
}

export interface PromptBenchmarkModeResult {
    status: 'passed' | 'failed';
    sql?: string;
    message?: string;
}

export interface PromptBenchmarkCase {
    question: string;
    seed: number;
    guided: PromptBenchmarkModeResult;
    direct: PromptBenchmarkModeResult;
}

export interface PromptBenchmarkSummary {
    passed: number;
    failed: number;
    passRate: number;
}

export interface PromptBenchmarkReport {
    seed: number;
    sampleSize: number;
    guided: PromptBenchmarkSummary;
    direct: PromptBenchmarkSummary;
    /** Guided pass rate minus direct pass rate, as a fraction from -1 through 1. */
    delta: number;
    interpretation: 'descriptive_only';
    caveat: string;
    cases: PromptBenchmarkCase[];
    output: string;
}

export async function runPromptBenchmark(
    database: Database,
    queries: readonly ApprovedQuery[],
    options: PromptBenchmarkOptions,
): Promise<PromptBenchmarkReport> {
    validateSeed(options.seed);
    if (queries.length === 0) throw new Error('Prompt benchmark requires at least one golden query.');

    const cases: PromptBenchmarkCase[] = [];
    for (let caseIndex = 0; caseIndex < queries.length; caseIndex += 1) {
        const query = queries[caseIndex];
        // Keep each pair adjacent and give both calls the exact same sampling
        // seed. The prompt is the only intended treatment difference.
        const guided = await evaluateMode(database, query, 'guided', caseIndex, options);
        const direct = await evaluateMode(database, query, 'direct', caseIndex, options);
        cases.push({ question: query.question, seed: options.seed, guided, direct });
    }

    const guided = summarize(cases.map((item) => item.guided));
    const direct = summarize(cases.map((item) => item.direct));
    const report: Omit<PromptBenchmarkReport, 'output'> = {
        seed: options.seed,
        sampleSize: cases.length,
        guided,
        direct,
        delta: guided.passRate - direct.passRate,
        interpretation: 'descriptive_only',
        caveat: 'One seeded run is descriptive and does not establish statistical significance.',
        cases,
    };
    return { ...report, output: formatPromptBenchmarkReport(report) };
}

export function formatPromptBenchmarkReport(
    report: Omit<PromptBenchmarkReport, 'output'>,
): string {
    const delta = report.delta * 100;
    const lines = [
        `Prompt benchmark: seed ${report.seed}; sample size ${report.sampleSize}.`,
        `Guided: ${report.guided.passed}/${report.sampleSize} ` +
            `(${percent(report.guided.passRate)}); direct: ` +
            `${report.direct.passed}/${report.sampleSize} (${percent(report.direct.passRate)}); ` +
            `delta ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} percentage points.`,
        `Caveat: ${report.caveat}`,
    ];
    for (const item of report.cases) {
        if (item.guided.status === 'failed') {
            lines.push(`FAIL guided — ${item.question}: ${item.guided.message ?? 'unknown failure'}`);
        }
        if (item.direct.status === 'failed') {
            lines.push(`FAIL direct — ${item.question}: ${item.direct.message ?? 'unknown failure'}`);
        }
    }
    return `${lines.join('\n')}\n`;
}

async function evaluateMode(
    database: Database,
    query: ApprovedQuery,
    mode: AskMode,
    caseIndex: number,
    options: PromptBenchmarkOptions,
): Promise<PromptBenchmarkModeResult> {
    try {
        const answer = await askQuestion(query.question, {
            mode,
            client: {
                complete: (prompt) => options.client.generate(prompt, {
                    seed: options.seed,
                    mode,
                    question: query.question,
                    caseIndex,
                }),
            },
            ...(mode === 'guided' ? {
                // Leave the current golden answer out of approved examples;
                // otherwise guided mode would be scored with its answer in
                // the prompt and the measured delta would be meaningless.
                guided: withoutCurrentGolden(options.guided, query),
            } : {}),
        });
        const sql = extractSql(answer.response);
        const evaluation = await runGoldenEval(database, [{ ...query, sql }], {
            dialect: options.dialect,
        });
        const result = evaluation.cases[0];
        return {
            status: result.status,
            sql,
            ...(result.message ? { message: result.message } : {}),
        };
    } catch (error) {
        return { status: 'failed', message: (error as Error).message };
    }
}

function withoutCurrentGolden(
    context: GuidedAskContext,
    query: ApprovedQuery,
): GuidedAskContext {
    return {
        ...context,
        project: {
            ...context.project,
            queries: context.project.queries.filter((candidate) =>
                candidate.question !== query.question),
        },
    };
}

function extractSql(response: string): string {
    const fenced = /^```(?:sql)?\s*([\s\S]*?)\s*```$/i.exec(response);
    const sql = (fenced?.[1] ?? response).trim();
    if (!sql) throw new Error('The generated SQL response was empty.');
    return sql;
}

function summarize(results: PromptBenchmarkModeResult[]): PromptBenchmarkSummary {
    const passed = results.filter((result) => result.status === 'passed').length;
    return {
        passed,
        failed: results.length - passed,
        passRate: passed / results.length,
    };
}

function validateSeed(seed: number): void {
    if (!Number.isSafeInteger(seed) || seed < 0) {
        throw new RangeError(`seed must be a non-negative safe integer, got ${seed}.`);
    }
}

function percent(value: number): string {
    return `${(value * 100).toFixed(2)}%`;
}
