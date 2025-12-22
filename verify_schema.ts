import { tools } from './src/mcp/tools/index.js';

console.log('Verifying tool schemas...');

let hasError = false;

for (const [name, tool] of Object.entries(tools)) {
    console.log(`Checking tool: ${name}`);
    const schema = tool.inputSchema;

    // Recursive function to check properties
    function checkSchema(obj: any, path: string) {
        if (!obj || typeof obj !== 'object') return;

        if (obj.type === 'array') {
            if (!obj.items) {
                console.error(`ERROR: ${path} has type 'array' but missing 'items'`);
                hasError = true;
            } else {
                console.log(`OK: ${path} is array with items`);
            }
        }

        if (obj.properties) {
            for (const [key, prop] of Object.entries(obj.properties)) {
                checkSchema(prop, `${path}.${key}`);
            }
        }
    }

    checkSchema(schema, name);
}

if (hasError) {
    console.error('Schema verification failed!');
    process.exit(1);
} else {
    console.log('All schemas passed generic validation checks.');
    process.exit(0);
}
