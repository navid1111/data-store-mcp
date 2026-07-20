import { SourceRegistry } from '../../sources/registry.js';

export const listMetricsTool = {
    name: 'list_metrics',
    description: 'List named metrics declared in the semantic model',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args: unknown) => ({
        metrics: SourceRegistry.getInstance().getSemanticRegistry().document.metrics,
    }),
};
