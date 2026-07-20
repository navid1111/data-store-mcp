import { z } from 'zod';
import { resolveModel } from '../../semantic/resolve.js';
import { SourceRegistry } from '../../sources/registry.js';
import { visibleModel } from '../../governance/clac.js';

export const describeModelTool = {
    name: 'describe_model',
    description: 'Describe one semantic model, including documented columns and profiled values',
    inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Case-sensitive semantic model name' } },
        required: ['name'],
    },
    handler: async (args: unknown) => {
        const { name } = z.object({ name: z.string() }).parse(args);
        const runtime = SourceRegistry.getInstance();
        const model = resolveModel(runtime.getSemanticRegistry(), name);
        return { model: visibleModel(model, runtime.resolvePolicy()) };
    },
};
