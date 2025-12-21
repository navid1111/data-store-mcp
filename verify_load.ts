
import { PostgresDatabase } from './src/postgres.js';
import { MysqlDatabase } from './src/mysql.js';
import { tools } from './src/mcp/tools/index.js';
import { ConnectionConfig } from './src/database-source.js';

console.log('Verifying imports...');

try {
    const config: ConnectionConfig = {
        id: 'test',
        type: 'postgres', // or mysql, purely for config
        options: {},
    };

    console.log('Instantiating PostgresDatabase...');
    const pgDb = new PostgresDatabase(config);
    console.log('PostgresDatabase instantiated successfully.');

    console.log('Instantiating MysqlDatabase...');
    const mysqlDb = new MysqlDatabase(config);
    console.log('MysqlDatabase instantiated successfully.');

    console.log('Checking tools...');
    const toolNames = Object.keys(tools);
    console.log('Available tools:', toolNames);

    if (!toolNames.includes('connect_database')) throw new Error('connect_database tool missing');
    if (!toolNames.includes('query_database')) throw new Error('query_database tool missing');

    console.log('Verification successful!');
} catch (error) {
    console.error('Verification failed:', error);
    process.exit(1);
}
