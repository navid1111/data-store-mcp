/** Provider-neutral guided/direct prompt orchestration (spec R6.4). */

import type { HybridMemoryRetriever, HybridSearchResult } from '../memory/retrieval.js';
import type { ProjectContext } from './context.js';
import type { SemanticRegistry } from '../semantic/registry.js';
import type { MdlDocument, Model } from '../semantic/types.js';

export interface AskPromptClient {
    complete(prompt: string): Promise<string>;
}

export type AskMode = 'guided' | 'direct';

export interface GuidedAskContext {
    semantic: SemanticRegistry;
    project: ProjectContext;
    retriever?: HybridMemoryRetriever;
    /** Qualified (`model.column`) or unqualified column names hidden by CLAC. */
    hiddenColumns?: ReadonlySet<string>;
    precedentLimit?: number;
}

export interface AskOptions {
    mode: AskMode;
    client: AskPromptClient;
    guided?: GuidedAskContext;
}

export interface AskResult {
    mode: AskMode;
    prompt: string;
    response: string;
}

/** Builds a prompt, calls the host-supplied LLM boundary, and returns both for evaluation. */
export async function askQuestion(question: string, options: AskOptions): Promise<AskResult> {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) throw new Error('Ask question must not be empty.');

    const prompt = options.mode === 'direct'
        ? normalizedQuestion
        : await buildGuidedPrompt(normalizedQuestion, requiredGuided(options.guided));
    const response = (await options.client.complete(prompt)).trim();
    if (!response) throw new Error('The configured LLM returned an empty response.');
    return { mode: options.mode, prompt, response };
}

export async function buildGuidedPrompt(
    question: string,
    context: GuidedAskContext,
): Promise<string> {
    const hidden = context.hiddenColumns ?? new Set<string>();
    const hiddenTokens = expandedHiddenTokens(hidden);
    const semantic = visibleDocument(context.semantic.document, hidden);
    const precedents = context.retriever
        ? await context.retriever.search(question, { limit: context.precedentLimit ?? 5 })
        : [];
    const visiblePrecedents = precedents.filter((precedent) =>
        !containsHidden(JSON.stringify(precedent.record), hiddenTokens));
    const approvedQueries = context.project.queries.filter((query) =>
        !containsHidden(JSON.stringify(query), hiddenTokens));

    const prompt = [
        'Answer the question using only the visible, reviewable project context below.',
        'Treat approved queries and prior art as examples, not as ground truth.',
        section('Question', question),
        section('Visible semantic schema', JSON.stringify(semantic, null, 2)),
        section('Project instructions', context.project.instructions.trim() || '(none)'),
        section('Approved query examples', approvedQueries.length
            ? JSON.stringify(approvedQueries, null, 2)
            : '(none)'),
        section('Retrieved precedents', formatPrecedents(visiblePrecedents)),
    ].join('\n\n');

    // Instructions and descriptions are freeform and may themselves mention a
    // hidden identifier. Scrub the completed prompt as a final fail-closed CLAC
    // boundary after the structural filtering above.
    return redactHidden(prompt, hiddenTokens);
}

function requiredGuided(context: GuidedAskContext | undefined): GuidedAskContext {
    if (!context) throw new Error('Guided ask requires semantic and project context.');
    return context;
}

function visibleDocument(
    document: Readonly<MdlDocument>,
    hidden: ReadonlySet<string>,
): MdlDocument {
    const models = document.models.map((model) => ({
        ...model,
        columns: model.columns.filter((column) => !isHidden(model, column.name, hidden)),
    }));
    const byName = new Map(models.map((model) => [model.name, model]));
    const metrics = document.metrics.filter((metric) => {
        const model = byName.get(metric.model);
        return model && !containsHidden(metric.expression, hiddenTokensForModel(model, hidden));
    });
    const metricNames = new Set(metrics.map((metric) => metric.name));

    return {
        models,
        relationships: document.relationships.filter((relationship) => {
            const from = byName.get(relationship.fromModel);
            const to = byName.get(relationship.toModel);
            return Boolean(from && to && relationship.joinKeys.every((key) =>
                !isHidden(from, key.fromColumn, hidden) &&
                !isHidden(to, key.toColumn, hidden)));
        }),
        metrics,
        views: document.views.map((view) => {
            const model = byName.get(view.model);
            return {
                ...view,
                columns: model
                    ? view.columns.filter((column) => !isHidden(model, column, hidden))
                    : [],
                metrics: view.metrics.filter((metric) => metricNames.has(metric)),
            };
        }),
        cubes: document.cubes.map((cube) => {
            const model = byName.get(cube.model);
            return {
                ...cube,
                dimensions: model
                    ? cube.dimensions.filter((column) => !isHidden(model, column, hidden))
                    : [],
                measures: cube.measures.filter((measure) =>
                    metricNames.has(measure) || (model ? !isHidden(model, measure, hidden) : false)),
            };
        }),
    };
}

function isHidden(model: Model, column: string, hidden: ReadonlySet<string>): boolean {
    return hidden.has(column) ||
        hidden.has(`${model.name}.${column}`) ||
        hidden.has(`${model.table}.${column}`);
}

function hiddenTokensForModel(model: Model, hidden: ReadonlySet<string>): string[] {
    return expandedHiddenTokens(new Set([...hidden].filter((entry) =>
        !entry.includes('.') || entry.startsWith(`${model.name}.`) || entry.startsWith(`${model.table}.`))));
}

function expandedHiddenTokens(hidden: ReadonlySet<string>): string[] {
    return [...new Set([...hidden].flatMap((entry) => {
        const normalized = entry.trim();
        if (!normalized) return [];
        const column = normalized.includes('.') ? normalized.slice(normalized.lastIndexOf('.') + 1) : normalized;
        return [normalized, column];
    }))].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function containsHidden(value: string, hiddenTokens: readonly string[]): boolean {
    return hiddenTokens.some((token) => identifierPattern(token).test(value));
}

function redactHidden(value: string, hiddenTokens: readonly string[]): string {
    return hiddenTokens.reduce((result, token) =>
        result.replace(identifierPattern(token), '[CLAC REDACTED]'), value);
}

function identifierPattern(value: string): RegExp {
    return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(value)}(?![A-Za-z0-9_])`, 'gi');
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function section(title: string, content: string): string {
    return `## ${title}\n${content}`;
}

function formatPrecedents(precedents: HybridSearchResult[]): string {
    if (precedents.length === 0) return '(none)';
    return precedents.map((precedent) => JSON.stringify({
        label: 'PRIOR ART — example only, not ground truth',
        question: precedent.record.question,
        sql: precedent.record.sql,
        resultShape: precedent.record.resultShape,
        ...(precedent.record.unverifiedModels.length > 0 ? {
            warning: `UNVERIFIED MODEL: ${precedent.record.unverifiedModels.join(', ')}`,
        } : {}),
    }, null, 2)).join('\n---\n');
}
