import { z } from 'zod';
import { SourceRegistry } from '../../sources/registry.js';

export const searchContextTool = {
    name: 'search_context',
    description: 'Search approved semantic context and prior query examples',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Context search text' },
            limit: { type: 'number', description: 'Maximum precedents to return (default 5)' },
        },
        required: ['query'],
    },
    handler: async (args: unknown) => {
        const parsed = z.object({
            query: z.string().trim().min(1),
            limit: z.number().int().min(1).max(20).optional(),
        }).parse(args);
        const retriever = SourceRegistry.getInstance().getMemoryRetriever();
        if (!retriever) return { precedents: [] };
        const results = await retriever.search(parsed.query, { limit: parsed.limit });
        return {
            precedents: results.map((result) => ({
                label: 'PRIOR ART — example only, not ground truth',
                question: result.record.question,
                sql: result.record.sql,
                resultShape: result.record.resultShape,
                durationMs: result.record.durationMs,
                ...(result.record.unverifiedModels.length > 0 ? {
                    warning: `UNVERIFIED MODEL: ${result.record.unverifiedModels.join(', ')}`,
                    unverifiedModels: result.record.unverifiedModels,
                } : {}),
                retrieval: {
                    score: result.score,
                    components: result.components,
                },
            })),
        };
    },
};
