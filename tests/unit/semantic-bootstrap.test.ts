import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/database-source.js';
import { bootstrapMdl } from '../../src/semantic/bootstrap.js';

describe('bootstrap introspection validation', () => {
  it('fails instead of silently skipping an unexpected table shape', async () => {
    const database = stubDatabase({ name: 'film', kind: 'unexpected' });
    await expect(bootstrapMdl(database, {
      source: 'fixture',
      outputPath: '/tmp/unused-invalid-bootstrap.yml',
    })).rejects.toThrow(/Unexpected table introspection shape/);
    expect(database.getSchema).not.toHaveBeenCalled();
  });

  it('fails when a declared table unexpectedly has no columns', async () => {
    const database = stubDatabase({ name: 'film', kind: 'table' });
    await expect(bootstrapMdl(database, {
      source: 'fixture',
      outputPath: '/tmp/unused-empty-bootstrap.yml',
    })).rejects.toThrow(/no columns.*film/i);
    expect(database.profile).not.toHaveBeenCalled();
  });
});

function stubDatabase(table: { name: string; kind: string }) {
  return {
    listTables: vi.fn().mockResolvedValue([table]),
    getSchema: vi.fn().mockResolvedValue([]),
    profile: vi.fn().mockResolvedValue([]),
  } as unknown as Database & {
    listTables: ReturnType<typeof vi.fn>;
    getSchema: ReturnType<typeof vi.fn>;
    profile: ReturnType<typeof vi.fn>;
  };
}
