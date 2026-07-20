/**
 * Tool error shaping for MCP responses.
 *
 * Tool *execution* failures are returned as results with `isError: true`, not
 * thrown. A thrown error becomes a JSON-RPC protocol error, which never enters
 * the model's tool-result stream — so the agent cannot read it and correct
 * itself. That correction loop is what spec.md R2.2 depends on.
 *
 * Protocol-level problems (an unknown tool name) are still thrown; those are
 * genuinely protocol errors and the client, not the model, should see them.
 *
 * This is an interim shape. Task 1.2 replaces it with the full structured
 * taxonomy (`governance/errors.ts`) carrying codes, source locations and
 * `did_you_mean` hints.
 */

import { ZodError } from 'zod';

export type ToolErrorCode = 'INVALID_ARGUMENTS' | 'EXECUTION_FAILED';

export interface ToolErrorPayload {
  error: {
    code: ToolErrorCode;
    message: string;
    issues?: Array<{ path: string; message: string }>;
  };
}

/**
 * Removes credentials from text that is about to be returned to the caller.
 *
 * Driver errors routinely embed the connection string — a failed MongoDB
 * handshake reports the full `mongodb://user:pass@host` URI — so any message
 * crossing the tool boundary is redacted first.
 */
export function redactSecrets(text: string): string {
  return (
    text
      // scheme://user:password@host
      .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:@\s/]+):[^@\s]+@/g, '$1:***@')
      // "password": "..." in serialized config
      .replace(/("(?:password|pwd)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"***"')
      // password=... in key/value connection strings
      .replace(/\b(password|pwd)=([^;&\s]+)/gi, '$1=***')
  );
}

/** Builds the structured payload for a failed tool execution. */
export function toToolErrorPayload(error: unknown): ToolErrorPayload {
  if (error instanceof ZodError) {
    return {
      error: {
        code: 'INVALID_ARGUMENTS',
        // Zod's default message is a JSON blob; flatten it to something an
        // agent can act on directly.
        message: error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
        issues: error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    error: {
      code: 'EXECUTION_FAILED',
      message: redactSecrets(message),
    },
  };
}

/** Builds the full MCP tool result for a failed execution. */
export function toToolErrorResult(error: unknown) {
  const payload = toToolErrorPayload(error);
  payload.error.message = redactSecrets(payload.error.message);

  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}
