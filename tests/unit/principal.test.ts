import { describe, expect, it } from 'vitest';
import {
  currentPrincipal,
  parsePrincipal,
  PrincipalRequiredError,
  runWithPrincipal,
} from '../../src/auth/principal.js';
import { invokeToolHandler } from '../../src/mcp/invoke.js';

describe('request principal context', () => {
  it('validates and normalizes out-of-band principals', () => {
    expect(parsePrincipal('  analyst@example.com  ', 'test')).toBe('analyst@example.com');
    expect(() => parsePrincipal(undefined, 'test')).toThrow(PrincipalRequiredError);
    expect(() => parsePrincipal('   ', 'test')).toThrow(PrincipalRequiredError);
    expect(() => parsePrincipal('bad\nprincipal', 'test')).toThrow(PrincipalRequiredError);
    expect(() => parsePrincipal('x'.repeat(257), 'test')).toThrow(PrincipalRequiredError);
  });

  it('fails closed outside a transport context', () => {
    expect(() => currentPrincipal()).toThrow(PrincipalRequiredError);
  });

  it('keeps concurrent request identities isolated', async () => {
    const first = parsePrincipal('first-user', 'test');
    const second = parsePrincipal('second-user', 'test');
    const observed = await Promise.all([
      runWithPrincipal(first, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return currentPrincipal();
      }),
      runWithPrincipal(second, async () => {
        await Promise.resolve();
        return currentPrincipal();
      }),
    ]);

    expect(observed).toEqual(['first-user', 'second-user']);
  });

  it('removes model-supplied identity before invoking a tool', async () => {
    const configured = parsePrincipal('configured-user', 'test');
    const result = await invokeToolHandler(async (args) => ({
      args,
      principal: currentPrincipal(),
    }), {
      principal: 'admin',
      sql: 'SELECT 1',
    }, configured);

    expect(result).toEqual({
      args: { sql: 'SELECT 1' },
      principal: 'configured-user',
    });
  });
});
