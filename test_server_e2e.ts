import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main() {
    console.log('Starting E2E test...');
    const transport = new StdioClientTransport({
        command: 'node',
        args: ['dist/server.js'],
    });

    const client = new Client({
        name: 'test-client',
        version: '1.0.0',
    }, {
        capabilities: {}
    });

    await client.connect(transport);

    console.log('Connected to server');

    try {
        console.log('Calling list_sources...');
        const sourcesResult = await client.callTool({
            name: 'list_sources',
            arguments: {},
        });
        console.log('Sources:', JSON.stringify(sourcesResult, null, 2));

        console.log('Calling query_database...');
        const queryResult = await client.callTool({
            name: 'query_database',
            arguments: {
                connectionId: process.env.TEST_SOURCE ?? 'analytics',
                sql: 'SELECT 1 as val'
            }
        });
        console.log('Query result:', JSON.stringify(queryResult, null, 2));

    } catch (e) {
        console.error('Error:', e);
        process.exit(1);
    }

    console.log('Test passed!');
    process.exit(0);
}

main();
