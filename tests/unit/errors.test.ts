/**
 * T0.11 — error shaping and secret redaction (criterion 5).
 * Behaviour through the real MCP server is covered in tests/e2e.
 */

import { describe, it, expect } from 'vitest';
import { z, ZodError } from 'zod';
import {
  redactSecrets,
  toToolErrorPayload,
  toToolErrorResult,
} from '../../src/mcp/errors.js';

describe('redactSecrets', () => {
  it('redacts credentials in a mongodb URI', () => {
    const text = 'failed to connect to mongodb://dsm:dsm_test_pw@127.0.0.1:57017/?authSource=admin';
    const out = redactSecrets(text);
    expect(out).not.toContain('dsm_test_pw');
    expect(out).toContain('mongodb://dsm:***@127.0.0.1:57017');
  });

  it('redacts credentials in a postgres URI', () => {
    expect(redactSecrets('postgres://user:hunter2@localhost:5432/db')).toBe(
      'postgres://user:***@localhost:5432/db'
    );
  });

  it('redacts a password field in serialized JSON', () => {
    const out = redactSecrets('{"user":"dsm","password":"hunter2","host":"x"}');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('"password":"***"');
    expect(out).toContain('"user":"dsm"'); // non-secrets preserved
  });

  it('redacts a password in a key/value connection string', () => {
    const out = redactSecrets('Server=x;User Id=dsm;Password=hunter2;Encrypt=true');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('Encrypt=true');
  });

  it('leaves text without secrets unchanged', () => {
    const text = 'relation "no_such_table" does not exist';
    expect(redactSecrets(text)).toBe(text);
  });

  it('redacts every occurrence, not only the first', () => {
    const out = redactSecrets('a=mongodb://u:p1@h1 b=mongodb://u:p2@h2');
    expect(out).not.toContain('p1');
    expect(out).not.toContain('p2');
  });
});

describe('toToolErrorPayload', () => {
  it('flattens a ZodError into readable field messages', () => {
    const schema = z.object({ connectionId: z.string(), sql: z.string() });
    let err: ZodError;
    try {
      schema.parse({ connectionId: 'x' });
      throw new Error('expected parse to fail');
    } catch (e) {
      err = e as ZodError;
    }

    const payload = toToolErrorPayload(err!);
    expect(payload.error.code).toBe('INVALID_ARGUMENTS');
    expect(payload.error.message).toMatch(/sql/);
    expect(payload.error.issues?.[0].path).toBe('sql');
  });

  it('classifies a plain Error as EXECUTION_FAILED and keeps its message', () => {
    const payload = toToolErrorPayload(new Error('Connection not found: nope'));
    expect(payload.error.code).toBe('EXECUTION_FAILED');
    // The specific message must survive — a generic "Tool execution failed"
    // gives the agent nothing to act on.
    expect(payload.error.message).toBe('Connection not found: nope');
  });

  it('handles a non-Error throw', () => {
    expect(toToolErrorPayload('bare string').error.message).toBe('bare string');
  });
});

describe('toToolErrorResult', () => {
  it('marks the result as an error and serializes the payload', () => {
    const result = toToolErrorResult(new Error('boom'));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error.message).toBe('boom');
  });

  it('redacts secrets in the serialized result', () => {
    const result = toToolErrorResult(
      new Error('connect failed: mongodb://dsm:dsm_test_pw@host/db')
    );
    expect(result.content[0].text).not.toContain('dsm_test_pw');
  });
});
