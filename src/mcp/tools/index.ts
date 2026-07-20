
/**
 * Tool registry - Central export for all MCP tools
 */

import { queryDatabaseTool } from './query.js';
import { listSourcesTool } from './list-sources.js';
import { dryPlanTool } from './dry-plan.js';
import { describeModelTool } from './describe-model.js';
import { listMetricsTool } from './list-metrics.js';
import { searchContextTool } from './search-context.js';

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
  [listSourcesTool.name]: listSourcesTool,
  [describeModelTool.name]: describeModelTool,
  [dryPlanTool.name]: dryPlanTool,
  [listMetricsTool.name]: listMetricsTool,
  [queryDatabaseTool.name]: queryDatabaseTool,
  [searchContextTool.name]: searchContextTool,
};
