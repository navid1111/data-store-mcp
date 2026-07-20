
import { tools } from './src/mcp/tools/index.js';

console.log('Verifying imports...');

try {
    console.log('Checking tools...');
    const toolNames = Object.keys(tools);
    console.log('Available tools:', toolNames);

    if (toolNames.includes('connect_database')) throw new Error('connect_database must not be exposed');
    if (!toolNames.includes('list_sources')) throw new Error('list_sources tool missing');
    if (!toolNames.includes('query_database')) throw new Error('query_database tool missing');

    console.log('Verification successful!');
} catch (error) {
    console.error('Verification failed:', error);
    process.exit(1);
}
