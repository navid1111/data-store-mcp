import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  confirmPublicDeployment,
  DEPLOYMENT_CONFIRMATION_PHRASE,
  DEPLOYMENT_CONFIRMATION_PROMPT,
} from '../../src/dashboard/confirmation.js';
import { deployDashboard } from '../../src/dashboard/deploy.js';

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, 'close');
  }));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('public dashboard deployment confirmation', () => {
  it('fails closed without an issued token and never contacts the provider', async () => {
    let requests = 0;
    const endpoint = await stubProvider((_request, response) => {
      requests += 1;
      response.end(JSON.stringify({ url: 'https://should-not-be-used.example.test' }));
    });

    await expect(deployDashboard('<!doctype html>', {
      endpoint,
      providerName: 'stub-pages',
    })).rejects.toThrow(/fresh human confirmation token is required/i);
    await expect(deployDashboard('<!doctype html>', {
      endpoint,
      providerName: 'stub-pages',
    }, {} as never)).rejects.toThrow(/fresh human confirmation token is required/i);
    expect(requests).toBe(0);
  });

  it('accepts the explicit phrase once and requires confirmation again for a retry', async () => {
    const endpoint = await stubProvider((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ url: 'https://confirmed.example.test/dashboard' }));
    });
    expect(DEPLOYMENT_CONFIRMATION_PROMPT).toMatch(/publish.*public.*internet/i);
    expect(() => confirmPublicDeployment('yes')).toThrow(/confirmation was not given/i);

    const token = confirmPublicDeployment(DEPLOYMENT_CONFIRMATION_PHRASE);
    await expect(deployDashboard('<!doctype html>', {
      endpoint,
      providerName: 'stub-pages',
    }, token)).resolves.toEqual({
      provider: 'stub-pages',
      url: 'https://confirmed.example.test/dashboard',
    });
    await expect(deployDashboard('<!doctype html>', {
      endpoint,
      providerName: 'stub-pages',
    }, token)).rejects.toThrow(/fresh human confirmation token is required/i);
  });

  it('offers no agent-reachable override and refuses non-interactive CLI deployment', async () => {
    let requests = 0;
    const endpoint = await stubProvider((_request, response) => {
      requests += 1;
      response.end(JSON.stringify({ url: 'https://should-not-be-used.example.test' }));
    });
    const directory = await mkdtemp(join(tmpdir(), 'data-store-mcp-deploy-gate-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'dashboard.html');
    await writeFile(file, '<!doctype html>', 'utf8');

    const base = [
      'dashboard', 'deploy', '--file', file, '--endpoint', endpoint,
      '--provider', 'stub-pages', '--json',
    ];
    const nonInteractive = await runCli(base);
    expect(nonInteractive.code).not.toBe(0);
    expect(nonInteractive.stdout).toBe('');
    expect(nonInteractive.stderr).toMatch(/publicly.*interactive human terminal/i);

    for (const forbiddenFlag of ['--yes', '--force']) {
      const result = await runCli([...base, forbiddenFlag]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(`Unknown option ${forbiddenFlag}`);
    }
    expect(requests).toBe(0);
  });
});

async function stubProvider(
  handler: RequestListener,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Stub provider did not bind.');
  return `http://127.0.0.1:${address.port}/deploy`;
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
