import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load.js';

const postgresSource = {
  name: 'analytics',
  type: 'postgres',
  description: 'Analytics warehouse',
  options: {
    host: 'db.internal',
    port: 5432,
    user: 'reader',
    password: '${DB_PASSWORD}',
    database: 'analytics',
  },
};

describe('parseConfig', () => {
  it('loads typed sources and expands credentials from the environment', () => {
    const config = parseConfig(
      { sources: [postgresSource], limits: { maxResultBytes: 4096 } },
      { DB_PASSWORD: 'server-side-secret' },
    );

    expect(config.sources).toEqual([
      {
        id: 'analytics',
        type: 'postgres',
        description: 'Analytics warehouse',
        options: {
          host: 'db.internal',
          port: 5432,
          user: 'reader',
          password: 'server-side-secret',
          database: 'analytics',
        },
      },
    ]);
    expect(config.execution).toEqual({ maxBytes: 4096 });
  });

  it('rejects duplicate source names', () => {
    expect(() =>
      parseConfig(
        { sources: [postgresSource, postgresSource] },
        { DB_PASSWORD: 'secret' },
      ),
    ).toThrow(/Duplicate source name: analytics/);
  });

  it('rejects a missing environment variable without exposing other values', () => {
    expect(() => parseConfig({ sources: [postgresSource] }, {})).toThrow(
      /missing environment variable: DB_PASSWORD/,
    );
  });

  it('rejects SQL Server because it is outside the active source scope', () => {
    expect(() =>
      parseConfig({
        sources: [{ ...postgresSource, type: 'sqlserver' }],
      }, { DB_PASSWORD: 'secret' }),
    ).toThrow();
  });

  it('rejects unknown config keys rather than silently accepting a typo', () => {
    expect(() =>
      parseConfig({
        sources: [{ ...postgresSource, pasword: 'typo' }],
      }, { DB_PASSWORD: 'secret' }),
    ).toThrow();
  });
});
