import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDashboard, writeDashboard } from '../../src/dashboard/generate.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('self-contained dashboard generation', () => {
  it('writes one offline HTML file with embedded metrics and filters', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'data-store-mcp-dashboard-'));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, 'nested', 'dashboard.html');

    await writeDashboard(outputPath, {
      title: 'Store performance',
      metrics: [
        {
          name: 'revenue',
          label: 'Revenue',
          value: 12500,
          unit: 'USD',
          dimensions: { region: 'North', period: '2026-Q1' },
        },
        {
          name: 'revenue',
          label: 'Revenue',
          value: 9800,
          unit: 'USD',
          dimensions: { region: 'South', period: '2026-Q1' },
        },
      ],
    });

    expect(await readdir(join(directory, 'nested'))).toEqual(['dashboard.html']);
    const html = await readFile(outputPath, 'utf8');
    for (const forbidden of ['http://', 'https://', 'src=', 'fetch(']) {
      expect(html.toLowerCase()).not.toContain(forbidden);
    }
    expect(html).toContain('Store performance');
    expect(html).toContain('12500 USD');
    expect(html).toContain('9800 USD');
    expect(html).toContain('"region":"North"');
    expect(html).toContain('data-filter="region"');
    expect(html).toContain("addEventListener('change', applyFilters)");
    expect(html).toContain("connect-src 'none'");
  });

  it('escapes markup without allowing embedded data to end the inline script', () => {
    const html = generateDashboard({
      title: '<Unsafe dashboard>',
      metrics: [{
        name: 'unsafe',
        value: '</script><script>globalThis.compromised = true</script>',
        dimensions: { segment: '<internal>' },
      }],
    });

    expect(html).not.toContain('</script><script>globalThis.compromised');
    expect(html).toContain('&lt;Unsafe dashboard&gt;');
    expect(html).toContain('\\u003c/script\\u003e');
  });
});
