# data-store-mcp

data-store-mcp - MCP server

This is a Model Context Protocol (MCP) server that provides tools for AI assistants.

## Features

- **Echo Tool**: Returns the input message with a timestamp

## Installation

```bash
npm install
```

## Usage

### Build

```bash
npm run build
```

### Development

```bash
npm run dev
```

### Start the server

```bash
npm start
```

The server will run on stdio and can be connected to by MCP clients.

## Available Tools

### echo

Echoes back the provided message.

**Input:**
```json
{
  "message": "Hello, world!"
}
```

**Output:**
```json
{
  "echoed": "Hello, world!",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Adding New Tools

To add a new tool:

1. Create a new file in `src/mcp/tools/` (e.g., `myTool.ts`)
2. Define your tool with name, description, inputSchema, and handler
3. Export the tool from `src/mcp/tools/index.ts`

Example:

```typescript
// src/mcp/tools/myTool.ts
import { z } from 'zod';

export const myTool = {
  name: 'myTool',
  description: 'Description of what the tool does',
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Input parameter description',
      },
    },
    required: ['input'],
  },
  handler: async (args: unknown) => {
    const schema = z.object({
      input: z.string(),
    });
    const parsed = schema.parse(args);
    
    // Your tool logic here
    return { result: parsed.input };
  },
};
```

## Project Structure

```
data-store-mcp/
├── src/
│   ├── server.ts           # Main server entry point
│   └── mcp/
│       └── tools/
│           ├── index.ts    # Tool registry
│           └── echo.ts     # Echo tool implementation
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT
