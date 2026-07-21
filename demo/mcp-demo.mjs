// Drives the real MCP server over stdio, the way an agent would.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'demo', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: 'node', args: ['dist/server.js'],
  env: { ...process.env, DATA_STORE_MCP_CONFIG: 'demo/config.json' },
}));

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
};

const show = (label, v) => console.log(`\n── ${label}\n${JSON.stringify(v, null, 2).slice(0, 700)}`);

show('tools/list', (await client.listTools()).tools.map((t) => t.name));
show('dry_plan with a typo', await call('dry_plan', {
  connectionId: 'pagila', sql: 'SELECT titel FROM film',
}));
show('query: DROP refused', await call('query', {
  connectionId: 'pagila', sql: 'DROP TABLE film',
}));
show('query: governed', await call('query', {
  connectionId: 'pagila', sql: 'SELECT title FROM film',
}).then((r) => ({ ...r, body: { ...r.body, results: `<${r.body.results?.length} rows>` } })));

await client.close();
