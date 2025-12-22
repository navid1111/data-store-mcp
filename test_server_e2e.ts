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
        console.log('Calling connect_database...');
        const result = await client.callTool({
            name: 'connect_database',
            arguments: {
                type: 'mysql',
                host: '127.0.0.1',
                port: 3306,
                user: 'root',
                password: 'root',
                database: 'sakila',
                id: 'my-mysql-connection'
            }
        });
        console.log('Connect result:', JSON.stringify(result, null, 2));

        console.log('Calling query_database...');
        const queryResult = await client.callTool({
            name: 'query_database',
            arguments: {
                connectionId: 'my-mysql-connection',
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
