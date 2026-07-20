import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHttpApp } from '../../src/express_server.js';
import { currentPrincipal } from '../../src/auth/principal.js';
import { AuditLog } from '../../src/audit/log.js';
import { SemanticRegistry } from '../../src/semantic/registry.js';
import { SourceRegistry } from '../../src/sources/registry.js';
import { PAGILA } from '../helpers/sources.js';

let directory: string;
let auditPath: string;
let configPathWithoutPrincipal: string;
let server: Server;
let baseUrl: string;
let registry: SourceRegistry;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'data-store-mcp-principal-'));
  auditPath = join(directory, 'http-audit.jsonl');
  const semanticPath = join(directory, 'semantic');
  await writeFile(semanticPath, `models:
  - name: film
    description: Film catalog.
    provenance: human
    verified: true
    source: http-pagila
    table: film
    columns:
      - name: film_id
        description: Film identifier.
        provenance: human
        verified: true
        dataType: integer
`, 'utf8');
  const semantic = await SemanticRegistry.loadFiles([semanticPath]);
  const audit = await AuditLog.open({
    path: auditPath,
    principalProvider: () => currentPrincipal(),
  });
  registry = await SourceRegistry.initialize(
    [{ ...PAGILA, id: 'http-pagila' }],
    {},
    audit,
    semantic,
  );

  const app = createHttpApp({
    resolvePrincipal(request) {
      switch (request.header('authorization')) {
        case 'Bearer analyst-token': return 'host-analyst';
        case 'Bearer reviewer-token': return 'host-reviewer';
        default: return undefined;
      }
    },
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  configPathWithoutPrincipal = join(directory, 'missing-principal.json');
  await writeFile(configPathWithoutPrincipal, JSON.stringify({
    semantic: { path: directory },
    audit: { path: join(directory, 'stdio-audit.jsonl') },
    sources: [{ name: 'pagila', type: 'postgres', options: PAGILA.options }],
  }), 'utf8');
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) =>
    error ? reject(error) : resolve()));
  const database = registry.getSource('http-pagila');
  await (database as unknown as { pool: { end(): Promise<void> } }).pool.end();
  await rm(directory, { recursive: true, force: true });
});

describe('out-of-band principal model', () => {
  it('uses the host principal per HTTP request and ignores a model-supplied admin principal', async () => {
    const [analyst, reviewer] = await Promise.all([
      postQuery('Bearer analyst-token', 41),
      postQuery('Bearer reviewer-token', 42),
    ]);

    expect(analyst.status).toBe(200);
    expect(analyst.body.results).toEqual([{ answer: 41 }]);
    expect(reviewer.status).toBe(200);
    expect(reviewer.body.results).toEqual([{ answer: 42 }]);

    const records = auditRecords(await readFile(auditPath, 'utf8'));
    expect(records.map((record) => record.principal).sort())
      .toEqual(['host-analyst', 'host-reviewer']);
    expect(records.some((record) => record.principal === 'admin')).toBe(false);
  });

  it('fails closed when the HTTP host supplies no authenticated principal', async () => {
    const before = auditRecords(await readFile(auditPath, 'utf8')).length;
    const response = await fetch(`${baseUrl}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        connectionId: 'http-pagila',
        sql: 'SELECT 99 AS answer',
        principal: 'admin',
      }),
    });
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('E_PRINCIPAL_REQUIRED');
    expect(auditRecords(await readFile(auditPath, 'utf8'))).toHaveLength(before);
  });

  it('fails stdio startup when its configuration has no principal', async () => {
    const result = await runServer(configPathWithoutPrincipal);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Server error:');
    expect(result.stderr).toMatch(/principal/i);
  }, 60_000);
});

async function postQuery(authorization: string, answer: number) {
  const response = await fetch(`${baseUrl}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization },
    body: JSON.stringify({
      connectionId: 'http-pagila',
      sql: `SELECT ${answer} AS answer`,
      principal: 'admin',
    }),
  });
  return { status: response.status, body: await response.json() as { results: unknown[] } };
}

function auditRecords(source: string): Array<{ principal: string }> {
  return source.trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { principal: string });
}

function runServer(configPath: string): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, DATA_STORE_MCP_CONFIG: configPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
