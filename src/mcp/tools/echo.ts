/**
 * Echo tool - Returns the input message
 */

import { z } from 'zod';

export const echoTool = {
  name: 'echo',
  description: 'Echoes back the provided message',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The message to echo back',
      },
    },
    required: ['message'],
  },
  handler: async (args: unknown) => {
    const schema = z.object({
      message: z.string(),
    });

    const parsed = schema.parse(args);

    return {
      echoed: parsed.message,
      timestamp: new Date().toISOString(),
    };
  },
};
