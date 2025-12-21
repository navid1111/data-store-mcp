/**
 * Tool registry - Central export for all MCP tools
 */

import { echoTool } from './echo.js';

export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: unknown) => Promise<unknown>;
}

export const tools: Record<string, Tool> = {
  [echoTool.name]: echoTool,
};
