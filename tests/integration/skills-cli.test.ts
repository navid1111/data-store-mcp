import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const skillsDirectory = fileURLToPath(new URL('../../skills/', import.meta.url));
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'data-store-mcp-skills-'));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('dsm workflow skills', () => {
  it('retrieves every shipped skill discovered from the directory', async () => {
    const files = (await readdir(skillsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort();
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('onboarding.md');

    for (const file of files) {
      const name = file.slice(0, -'.md'.length);
      const expected = await readFile(join(skillsDirectory, file), 'utf8');
      const result = await runCli(['skills', 'get', name]);
      expect(result.code, name).toBe(0);
      expect(result.stderr, name).toBe('');
      expect(result.stdout, name).toBe(expected.endsWith('\n') ? expected : `${expected}\n`);
      expect(result.stdout, name).toContain('## Goal');
      expect(result.stdout, name).toContain('## Workflow');
      expect(result.stdout, name).toContain('## Guardrails');
    }
  });

  it('lists dynamically discovered names when a skill is unknown', async () => {
    const names = (await readdir(skillsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name.slice(0, -'.md'.length));
    const result = await runCli(['skills', 'get', 'does-not-exist']);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Available skills:');
    for (const name of names) expect(result.stderr).toContain(name);
  });

  it('adds one idempotent discovery entry without clobbering client config', async () => {
    const configPath = join(directory, 'client.json');
    const initial = {
      theme: 'dark',
      nested: { preserve: ['every', 'value'] },
      mcpServers: {
        existing: { command: 'existing-mcp', args: ['serve'] },
      },
    };
    await writeFile(configPath, JSON.stringify(initial), 'utf8');

    const first = await runCli([
      'skills', 'add', '--config', configPath, '--command', '/opt/bin/dsm', '--json',
    ]);
    const afterFirst = await readFile(configPath, 'utf8');
    const second = await runCli([
      'skills', 'add', '--config', configPath, '--command', '/opt/bin/dsm', '--json',
    ]);
    const afterSecond = await readFile(configPath, 'utf8');

    expect(first.code).toBe(0);
    expect(first.stderr).toBe('');
    expect(JSON.parse(first.stdout)).toMatchObject({ changed: true });
    expect(second.code).toBe(0);
    expect(second.stderr).toBe('');
    expect(JSON.parse(second.stdout)).toMatchObject({ changed: false });
    expect(afterSecond).toBe(afterFirst);

    const installed = JSON.parse(afterSecond);
    expect(installed.theme).toBe(initial.theme);
    expect(installed.nested).toEqual(initial.nested);
    expect(installed.mcpServers.existing).toEqual(initial.mcpServers.existing);
    expect(installed.mcpServers['data-store-mcp']).toEqual({
      command: '/opt/bin/dsm',
      args: ['serve'],
    });
    expect(Object.keys(installed.mcpServers)
      .filter((name) => name === 'data-store-mcp')).toHaveLength(1);
  });

  it('refuses to overwrite a conflicting discovery entry', async () => {
    const configPath = join(directory, 'conflict.json');
    const original = JSON.stringify({
      unrelated: true,
      mcpServers: {
        'data-store-mcp': { command: 'custom-wrapper', args: ['start'] },
      },
    });
    await writeFile(configPath, original, 'utf8');

    const result = await runCli(['skills', 'add', '--config', configPath]);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('conflicting data-store-mcp');
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });
});

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/cli/index.js', ...args], {
      cwd: process.cwd(),
      env: process.env,
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
