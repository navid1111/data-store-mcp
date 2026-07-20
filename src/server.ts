#!/usr/bin/env node

/**
 * data-store-mcp - MCP Server
 * MCP server with database support
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools } from './mcp/tools/index.js';
import { toToolErrorResult } from './mcp/errors.js';
import { loadConfig } from './config/load.js';
import { SourceRegistry } from './sources/registry.js';

/**
 * Create and configure the MCP server
 */
function createServer(): Server {
  const server = new Server(
    {
      name: 'data-store-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: Object.values(tools).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  // Handle tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools[name];

    // An unknown tool is a protocol error, not an execution failure: the
    // client called something that was never advertised. This one still throws.
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    try {
      const result = await tool.handler(args || {});
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      // Returned, not thrown — see src/mcp/errors.ts for why.
      return toToolErrorResult(error);
    }
  });

  return server;
}

/**
 * Start the server
 */
async function main() {
  const config = await loadConfig();
  await SourceRegistry.initialize(config.sources, config.execution);

  const server = createServer();
  const transport = new StdioServerTransport();
  
  await server.connect(transport);
  
  // eslint-disable-next-line no-console
  console.error('data-store-mcp MCP server running on stdio with database support');
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Server error:', error);
  process.exit(1);
});
