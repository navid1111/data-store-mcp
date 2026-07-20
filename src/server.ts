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
import { AuditLog } from './audit/log.js';
import type { ConnectionConfig } from './database-source.js';
import { SemanticRegistry } from './semantic/registry.js';
import { ExecutionMemoryIndex } from './memory/index.js';
import { HybridMemoryRetriever } from './memory/retrieval.js';
import { HashEmbeddingProvider } from './memory/embedding.js';

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
  const auditLog = await AuditLog.open({
    ...config.audit,
    secrets: credentialSecrets(config.sources),
  });
  const semanticRegistry = await SemanticRegistry.load(config.semanticPath);
  const memoryIndex = config.memoryPath
    ? await ExecutionMemoryIndex.open(config.memoryPath)
    : undefined;
  const memoryRetriever = memoryIndex
    ? new HybridMemoryRetriever(memoryIndex, new HashEmbeddingProvider())
    : undefined;
  await SourceRegistry.initialize(
    config.sources,
    config.execution,
    auditLog,
    semanticRegistry,
    memoryIndex,
    memoryRetriever,
  );

  const server = createServer();
  const transport = new StdioServerTransport();
  
  await server.connect(transport);
  
  // eslint-disable-next-line no-console
  console.error('data-store-mcp MCP server running on stdio with database support');
}

function credentialSecrets(sources: ConnectionConfig[]): string[] {
  return sources.flatMap((source) => {
    if (source.type !== 'mongodb') return [source.options.password];

    try {
      const password = new URL(source.options.uri).password;
      return password ? [password, decodeURIComponent(password)] : [];
    } catch {
      // connect() reports an invalid URI during startup; audit setup must not
      // echo it while trying to extract a redaction value.
      return [];
    }
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Server error:', error);
  process.exit(1);
});
