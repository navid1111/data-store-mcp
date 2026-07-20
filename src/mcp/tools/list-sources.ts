import { SourceRegistry } from '../../sources/registry.js';

export const listSourcesTool = {
    name: 'list_sources',
    description: 'List the database sources configured by the server administrator',
    inputSchema: {
        type: 'object',
        properties: {},
    },
    handler: async (_args: unknown) => ({
        sources: SourceRegistry.getInstance().listSources(),
    }),
};
