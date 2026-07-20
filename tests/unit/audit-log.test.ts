import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '../../src/audit/log.js';
import { executeWithAudit } from '../../src/audit/execution.js';
import { timeout, writeForbidden } from '../../src/governance/errors.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe('AuditLog', () => {
  it('appends records without rewriting existing bytes and redacts credentials', async () => {
    const { directory, path } = await temporaryLog();
    const original = '{"existing":true}\n';
    await writeFile(path, original);
    const log = await AuditLog.open({
      path,
      principal: 'analyst',
      secrets: ['fixture-password'],
    });

    await Promise.all([
      log.append(record("SELECT 'fixture-password'", 'success')),
      log.append(record('SELECT 2', 'failure')),
    ]);

    const contents = await readFile(path, 'utf8');
    expect(contents.startsWith(original)).toBe(true);
    expect(contents).not.toContain('fixture-password');
    expect(contents.trim().split('\n')).toHaveLength(3);
    expect(directory).toBeTruthy();
  });

  it('records successes, denials, and timeouts exactly once', async () => {
    const { path } = await temporaryLog();
    const log = await AuditLog.open({ path, principal: 'analyst' });

    await executeWithAudit(log, { source: 'db', sql: 'SELECT 1' }, async (context) => {
      context.sql = 'SELECT 1 LIMIT 1000';
      context.appliedPolicies.push('read-only', 'limit:1000');
      return { value: 1, rowCount: 1 };
    });
    await executeWithAudit(log, { source: 'db', sql: 'DELETE FROM film' }, async () => {
      throw writeForbidden('delete');
    }).catch(() => undefined);
    await executeWithAudit(log, { source: 'db', sql: 'SELECT pg_sleep(5)' }, async (context) => {
      context.appliedPolicies.push('read-only');
      throw timeout(500);
    }).catch(() => undefined);

    const records = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(3);
    expect(records.map((entry) => entry.outcome)).toEqual(['success', 'denied', 'timeout']);
    expect(records[1].appliedPolicies).toEqual(['read-only']);
    expect(records[2].errorCode).toBe('E_TIMEOUT');
  });
});

function record(sql: string, outcome: 'success' | 'failure') {
  return {
    source: 'db',
    sql,
    appliedPolicies: [],
    rowCount: outcome === 'success' ? 1 : 0,
    durationMs: 1,
    outcome,
  } as const;
}

async function temporaryLog() {
  const directory = await mkdtemp(join(tmpdir(), 'data-store-mcp-audit-'));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, 'audit.jsonl') };
}
