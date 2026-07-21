/**
 * Bundles the MCP server into the extension.
 *
 * LanceDB (the memory index) ships prebuilt .node binaries, so it cannot be
 * bundled and is marked external. Its package is copied next to the bundle,
 * which makes the resulting VSIX platform-specific — see EXTENSION.md.
 */
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');          // the server repo
const outDir = resolve(here, '..', 'dist', 'server');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'server.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: join(outDir, 'server.cjs'),
  external: ['pg-native', '@lancedb/*', 'vectordb'],
  logLevel: 'info',
});

// Copy LanceDB and its platform binary alongside the bundle.
const modules = join(root, 'node_modules', '@lancedb');
if (existsSync(modules)) {
  await cp(modules, join(outDir, 'node_modules', '@lancedb'), { recursive: true });
  console.log('copied @lancedb native packages');
} else {
  console.warn('WARNING: @lancedb not found — search_context will be unavailable');
}
