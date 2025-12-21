
import { connectDatabaseTool } from './src/mcp/tools/connect.js';
import { queryDatabaseTool } from './src/mcp/tools/query.js';

async function testConnection() {
    console.log('Testing MySQL connection...');

    const connectArgs = {
        type: 'mysql',
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        password: 'root',
        database: 'sakila',
        id: 'my-mysql-connection'
    };

    try {
        console.log('Connecting with args:', JSON.stringify(connectArgs, null, 2));
        const connectResult = await connectDatabaseTool.handler(connectArgs);
        console.log('Connection result:', connectResult);

        console.log('Running query: SELECT 1...');
        const queryResult = await queryDatabaseTool.handler({
            connectionId: 'my-mysql-connection',
            sql: 'SELECT 1 as val'
        });
        console.log('Query result:', JSON.stringify(queryResult, null, 2));

        console.log('Running query: Select tables from information_schema...');
        const tablesResult = await queryDatabaseTool.handler({
            connectionId: 'my-mysql-connection',
            sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'sakila' LIMIT 5"
        });
        console.log('Tables result:', JSON.stringify(tablesResult, null, 2));

    } catch (error) {
        console.error('Test failed:', error);
        process.exit(1);
    }
}

testConnection();
