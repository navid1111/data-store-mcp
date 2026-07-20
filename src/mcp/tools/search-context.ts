export const searchContextTool = {
    name: 'search_context',
    description: 'Search approved semantic context and prior query examples',
    inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Context search text' } },
        required: ['query'],
    },
    // The durable retrieval index lands in task 3.5. Publishing the stable R6.1
    // shape now lets clients adopt the final surface without another rename.
    handler: async (_args: unknown) => ({ precedents: [] }),
};
