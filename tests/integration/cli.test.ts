import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PAGILA } from '../helpers/sources.js';
import { ExecutionMemoryIndex } from '../../src/memory/index.js';

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

let directory: string;
let configPath: string;
let bootstrapPath: string;
let llmStubPath: string;
let promptCapturePath: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'data-store-mcp-cli-'));
  configPath = join(directory, 'config.json');
  bootstrapPath = join(directory, 'generated', 'pagila.yml');
  llmStubPath = join(directory, 'llm-stub.mjs');
  promptCapturePath = join(directory, 'prompts.jsonl');
  const semanticPath = join(directory, 'semantic');
  const memoryPath = join(directory, 'memory');
  await mkdir(semanticPath);
  await writeFile(join(semanticPath, 'semantic.yml'), `models:
  - name: film
    description: Film catalog.
    provenance: human
    verified: true
    source: cli-pagila
    table: film
    columns:
      - name: film_id
        description: Film identifier.
        provenance: human
        verified: true
        dataType: integer
`, 'utf8');
  await writeFile(join(directory, 'instructions.md'),
    '# Query rules\nUse reviewed catalog definitions.\n', 'utf8');
  await writeFile(join(directory, 'queries.yml'), `queries:
  - question: How many films are available?
    sql: SELECT COUNT(*) AS film_count FROM film
`, 'utf8');
  await writeFile(llmStubPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  appendFileSync(process.env.DSM_LLM_CAPTURE, JSON.stringify(prompt) + '\\n');
  process.stdout.write('stubbed CLI answer\\n');
});
`, 'utf8');
  await chmod(llmStubPath, 0o700);
  const memory = await ExecutionMemoryIndex.open(memoryPath);
  await memory.recordExecution({
    success: true,
    question: 'Count available films',
    sql: 'SELECT COUNT(*) AS film_count FROM film',
    rows: [{ film_count: 1000 }],
    durationMs: 5,
  });
  memory.close();
  await writeFile(configPath, JSON.stringify({
    principal: 'cli-test',
    semantic: { path: semanticPath },
    audit: { path: join(directory, 'audit.jsonl') },
    memory: { path: memoryPath },
    limits: { maxResultBytes: 1024 * 1024, timeoutMs: 5_000 },
    sources: [{
      name: 'cli-pagila',
      type: 'postgres',
      description: 'CLI Pagila fixture',
      options: PAGILA.options,
    }],
  }), 'utf8');
}, 60_000);

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('dsm CLI core commands', () => {
  it('provides help for every command without diagnostics', async () => {
    const commands = [
      ['serve', '--help'],
      ['mdl', 'lint', '--help'],
      ['mdl', 'bootstrap', '--help'],
      ['ask', '--help'],
      ['query', '--help'],
      ['skills', '--help'],
    ];

    for (const command of commands) {
      const result = await runCli(command);
      expect(result.code, command.join(' ')).toBe(0);
      expect(result.stdout, command.join(' ')).toContain('Usage:');
      expect(result.stderr, command.join(' ')).toBe('');
    }
  });

  it('passes different guided and direct prompts to a configured LLM command', async () => {
    await rm(promptCapturePath, { force: true });
    const question = 'How many films are available?';
    const environment = { DSM_LLM_CAPTURE: promptCapturePath };
    const guided = await runCli([
      'ask', question, '--guided', '--config', configPath, '--project', directory,
      '--llm-command', llmStubPath, '--json',
    ], environment);
    const direct = await runCli([
      'ask', '--direct', question, '--llm-command', llmStubPath, '--json',
    ], environment);

    expect(guided.code).toBe(0);
    expect(guided.stderr).toBe('');
    expect(JSON.parse(guided.stdout)).toEqual({ mode: 'guided', response: 'stubbed CLI answer' });
    expect(direct.code).toBe(0);
    expect(direct.stderr).toBe('');
    expect(JSON.parse(direct.stdout)).toEqual({ mode: 'direct', response: 'stubbed CLI answer' });

    const prompts = (await readFile(promptCapturePath, 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as string);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('## Visible semantic schema');
    expect(prompts[0]).toContain('Film identifier.');
    expect(prompts[0]).toContain('Use reviewed catalog definitions.');
    expect(prompts[0]).toContain('Count available films');
    expect(prompts[1]).toBe(question);
    expect(prompts[0]).not.toBe(prompts[1]);
  }, 60_000);

  it('validates server startup dependencies and exits cleanly in check mode', async () => {
    const result = await runCli(['serve', '--config', configPath, '--check', '--json']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, sources: ['cli-pagila'] });
  }, 60_000);

  it('bootstraps and then lints a live MDL artifact', async () => {
    const bootstrap = await runCli([
      'mdl', 'bootstrap', '--config', configPath,
      '--source', 'cli-pagila', '--output', bootstrapPath, '--json',
    ]);
    expect(bootstrap.code).toBe(0);
    expect(bootstrap.stderr).toBe('');
    expect(JSON.parse(bootstrap.stdout)).toMatchObject({
      ok: true,
      outputPath: bootstrapPath,
      changed: true,
    });
    expect(await readFile(bootstrapPath, 'utf8')).toContain('name: film');

    const lint = await runCli([
      'mdl', 'lint', '--config', configPath,
      '--source', 'cli-pagila', '--file', bootstrapPath, '--json',
    ]);
    expect(lint.code).toBe(0);
    expect(lint.stderr).toBe('');
    expect(JSON.parse(lint.stdout)).toEqual({ ok: true, findings: [] });
  }, 60_000);

  it('prints governed query data as JSON on stdout only', async () => {
    const result = await runCli([
      'query', '--config', configPath, '--source', 'cli-pagila',
      '--sql', 'SELECT 42 AS answer', '--json',
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      source: 'cli-pagila',
      appliedPolicies: ['limit:1000', 'read-only'],
      rows: [{ answer: 42 }],
    });
  }, 60_000);

  it('uses non-zero exits and stderr for invalid input', async () => {
    const invalidCommands = [
      ['serve', '--config', join(directory, 'missing.json'), '--check'],
      ['mdl', 'lint', '--config', configPath, '--source', 'cli-pagila'],
      ['mdl', 'bootstrap', '--config', configPath, '--source', 'cli-pagila'],
      ['ask', 'question'],
      ['query', '--config', configPath, '--source', 'cli-pagila', '--sql', 'DELETE FROM film'],
    ];

    for (const command of invalidCommands) {
      const result = await runCli(command);
      expect(result.code, command.join(' ')).not.toBe(0);
      expect(result.stdout, command.join(' ')).toBe('');
      expect(result.stderr, command.join(' ')).not.toBe('');
    }
  }, 60_000);
});

function runCli(args: string[], environment: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/cli/index.js', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
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
