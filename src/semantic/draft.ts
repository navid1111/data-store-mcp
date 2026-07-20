/** Untrusted LLM drafting boundary for bootstrap (spec R3.7/§5.3). */

import { z } from 'zod';
import type { MdlDocument, Metric, Model } from './types.js';

export interface MdlDraftClient {
    /** Implementations are supplied by the host; tests use only local stubs. */
    draft(prompt: string): Promise<unknown>;
}

export interface DraftOptions {
    client: MdlDraftClient;
    /** Query-log/artifact evidence, clearly labeled as unverified context. */
    artifacts?: readonly string[];
}

const responseSchema = z.object({
    description: z.string().trim().min(1).optional(),
    verified: z.boolean().optional(),
    metrics: z.array(z.object({
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        description: z.string().trim().min(1),
        expression: z.string().trim().min(1),
        verified: z.boolean().optional(),
    }).passthrough()).optional(),
}).passthrough();

export async function draftMdl(
    input: MdlDocument,
    options: DraftOptions,
): Promise<MdlDocument> {
    const document = structuredClone(input);
    const metrics: Metric[] = [...document.metrics];
    const metricNames = new Set(metrics.map((metric) => metric.name));

    for (const model of document.models) {
        // A structural fallback is not business meaning. If drafting fails,
        // leave this visibly empty for the description-coverage linter.
        model.description = '';
        const response = responseSchema.safeParse(
            await options.client.draft(buildDraftPrompt(model, options.artifacts ?? [])),
        );
        if (!response.success) continue;

        if (response.data.description) {
            model.description = response.data.description;
            model.provenance = 'llm_draft';
        }
        // Never read response.data.verified. Verification is a human action.
        model.verified = false;

        for (const proposal of response.data.metrics ?? []) {
            if (metricNames.has(proposal.name)) continue;
            metricNames.add(proposal.name);
            metrics.push({
                name: proposal.name,
                description: proposal.description,
                provenance: 'llm_draft',
                verified: false,
                model: model.name,
                expression: proposal.expression,
            });
        }
    }

    document.metrics = metrics.sort((left, right) => left.name.localeCompare(right.name));
    return document;
}

export function buildDraftPrompt(model: Model, artifacts: readonly string[]): string {
    return [
        'Draft a concise business description and optional aggregate metrics for this unverified MDL model.',
        'Return JSON only: {"description": string, "metrics": [{"name": string, "description": string, "expression": string}]}.',
        'You cannot grant verification. Do not claim inferred meaning as fact.',
        `Table: ${model.table}`,
        `Columns and profiles:\n${JSON.stringify(model.columns.map((column) => ({
            name: column.name,
            dataType: column.dataType,
            profile: column.profile,
        })), null, 2)}`,
        `Existing SQL/artifact evidence (unverified):\n${artifacts.length ? artifacts.join('\n---\n') : '(none)'}`,
    ].join('\n\n');
}
