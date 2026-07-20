
/**
 * Tool registry - Central export for all MCP tools
 */

import { echoTool } from './echo.js';
import { queryDatabaseTool } from './query.js';
import { inspectDatabaseTool } from './inspector.js';
import { listSourcesTool } from './list-sources.js';
import { dryPlanTool } from './dry-plan.js';

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
  [listSourcesTool.name]: listSourcesTool,
  [dryPlanTool.name]: dryPlanTool,
  [queryDatabaseTool.name]: queryDatabaseTool,
  [inspectDatabaseTool.name]: inspectDatabaseTool,
};
