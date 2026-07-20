/** Self-contained dashboard generation from already-governed metric values. */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type DashboardScalar = string | number | boolean | null;

export interface DashboardMetric {
    name: string;
    label?: string;
    value: DashboardScalar;
    unit?: string;
    dimensions?: Readonly<Record<string, DashboardScalar>>;
}

export interface DashboardSpec {
    title: string;
    metrics: readonly DashboardMetric[];
}

/** Generates one HTML document with all data, styles, and behavior inlined. */
export function generateDashboard(spec: DashboardSpec): string {
    const dashboard = validateDashboard(spec);
    const filters = [...new Set(dashboard.metrics.flatMap((metric) =>
        Object.keys(metric.dimensions ?? {})))].sort();
    const serialized = safeJson(dashboard);

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src data:">
  <title>${escapeHtml(dashboard.title)}</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #f5f7fb; color: #172033; }
    main { max-width: 72rem; margin: 0 auto; padding: 2rem; }
    h1 { margin: 0 0 1.5rem; font-size: clamp(1.7rem, 4vw, 2.6rem); }
    #filters { display: flex; flex-wrap: wrap; gap: .75rem; margin-bottom: 1.5rem; }
    label { display: grid; gap: .3rem; font-size: .8rem; font-weight: 700; }
    select { min-width: 10rem; padding: .55rem; border: 1px solid #c8cfdd; border-radius: .5rem; background: white; }
    #metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 1rem; }
    .metric-card { padding: 1.1rem; border: 1px solid #dce1ec; border-radius: .8rem; background: white; box-shadow: 0 .2rem .7rem #1b29451a; }
    .metric-name { margin: 0; color: #58647a; font-size: .85rem; }
    .metric-value { margin: .35rem 0; font-size: 1.8rem; font-weight: 750; }
    .dimensions { margin: .65rem 0 0; font-size: .75rem; color: #6c7688; }
    #empty { padding: 1rem; border-radius: .7rem; background: #fff4d8; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(dashboard.title)}</h1>
    <form id="filters" aria-label="Dashboard filters">
${filters.map((filter) => `      <label>${escapeHtml(filter)}<select data-filter="${escapeAttribute(filter)}"><option value="">All</option></select></label>`).join('\n')}
    </form>
    <section id="metric-grid" aria-live="polite">
${dashboard.metrics.map((metric, index) => metricCard(metric, index)).join('\n')}
    </section>
    <p id="empty" hidden>No metrics match the selected filters.</p>
  </main>
  <script id="dashboard-data" type="application/json">${serialized}</script>
  <script>
    (() => {
      'use strict';
      const dashboard = JSON.parse(document.getElementById('dashboard-data').textContent);
      const selectors = [...document.querySelectorAll('[data-filter]')];
      const cards = [...document.querySelectorAll('[data-metric-index]')];
      const key = (value) => JSON.stringify(value);

      for (const selector of selectors) {
        const dimension = selector.dataset.filter;
        const values = [...new Map(dashboard.metrics
          .filter((metric) => Object.prototype.hasOwnProperty.call(metric.dimensions || {}, dimension))
          .map((metric) => [key(metric.dimensions[dimension]), metric.dimensions[dimension]])).values()]
          .sort((left, right) => String(left).localeCompare(String(right)));
        for (const value of values) {
          const option = document.createElement('option');
          option.value = key(value);
          option.textContent = String(value);
          selector.append(option);
        }
      }

      const applyFilters = () => {
        let visible = 0;
        for (const card of cards) {
          const metric = dashboard.metrics[Number(card.dataset.metricIndex)];
          const matches = selectors.every((selector) =>
            selector.value === '' || key((metric.dimensions || {})[selector.dataset.filter]) === selector.value);
          card.hidden = !matches;
          if (matches) visible += 1;
        }
        document.getElementById('empty').hidden = visible !== 0;
      };
      for (const selector of selectors) selector.addEventListener('change', applyFilters);
    })();
  </script>
</body>
</html>
`;
}

/** Writes exactly one generated dashboard artifact. */
export async function writeDashboard(outputPath: string, spec: DashboardSpec): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, generateDashboard(spec), 'utf8');
}

function validateDashboard(spec: DashboardSpec): DashboardSpec {
    if (!spec.title.trim()) throw new Error('Dashboard title must not be empty.');
    if (spec.metrics.length === 0) throw new Error('Dashboard requires at least one metric.');
    for (const metric of spec.metrics) {
        if (!metric.name.trim()) throw new Error('Dashboard metric names must not be empty.');
        if (typeof metric.value === 'number' && !Number.isFinite(metric.value)) {
            throw new Error(`Dashboard metric "${metric.name}" has a non-finite value.`);
        }
    }
    return spec;
}

function metricCard(metric: DashboardMetric, index: number): string {
    const dimensions = Object.entries(metric.dimensions ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `${escapeHtml(name)}: ${escapeHtml(displayValue(value))}`)
        .join(' · ');
    return `      <article class="metric-card" data-metric-index="${index}">
        <p class="metric-name">${escapeHtml(metric.label ?? metric.name)}</p>
        <p class="metric-value">${escapeHtml(displayValue(metric.value))}${metric.unit ? ` ${escapeHtml(metric.unit)}` : ''}</p>
        ${dimensions ? `<p class="dimensions">${dimensions}</p>` : ''}
      </article>`;
}

function displayValue(value: DashboardScalar): string {
    return value === null ? '—' : String(value);
}

function safeJson(value: unknown): string {
    return JSON.stringify(value)
        .replace(/&/g, '\\u0026')
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e');
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttribute(value: string): string {
    return escapeHtml(value);
}
