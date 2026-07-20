import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import { once } from 'node:events';
import { deployDashboard } from '../../src/dashboard/deploy.js';
import { generateDashboard } from '../../src/dashboard/generate.js';
import {
  confirmPublicDeployment,
  DEPLOYMENT_CONFIRMATION_PHRASE,
} from '../../src/dashboard/confirmation.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, 'close');
  }));
});

describe('dashboard provider deployment', () => {
  it('uploads to a stubbed provider API and returns its URL', async () => {
    let requestBody = '';
    let authorization: string | undefined;
    const endpoint = await stubProvider((request, response) => {
      authorization = request.headers.authorization;
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { requestBody += chunk; });
      request.on('end', () => {
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ url: 'https://preview.example.test/store-dashboard' }));
      });
    });
    const html = generateDashboard({
      title: 'Deployment fixture',
      metrics: [{ name: 'orders', value: 42 }],
    });

    const confirmation = confirmPublicDeployment(DEPLOYMENT_CONFIRMATION_PHRASE);
    const deployment = await deployDashboard(html, {
      endpoint,
      providerName: 'stub-pages',
      bearerToken: 'fixture-token',
      siteName: 'store-dashboard',
    }, confirmation);

    expect(deployment).toEqual({
      provider: 'stub-pages',
      url: 'https://preview.example.test/store-dashboard',
    });
    expect(authorization).toBe('Bearer fixture-token');
    expect(JSON.parse(requestBody)).toEqual({
      siteName: 'store-dashboard',
      files: [{ path: 'index.html', content: html }],
    });
  });

  it('reports a stubbed provider failure instead of swallowing it', async () => {
    const endpoint = await stubProvider((_request, response) => {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('provider maintenance');
    });

    await expect(deployDashboard('<!doctype html>', {
      endpoint,
      providerName: 'stub-pages',
    }, confirmPublicDeployment(DEPLOYMENT_CONFIRMATION_PHRASE))).rejects.toThrow(
      'Dashboard deployment to stub-pages failed (503): provider maintenance',
    );
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
