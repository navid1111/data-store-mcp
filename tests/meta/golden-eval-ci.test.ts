import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const workflowPath = new URL('../../.github/workflows/golden-eval.yml', import.meta.url);

describe('golden evaluation CI gate', () => {
  it('triggers for semantic data and golden query changes', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    expect(workflow).toContain("- 'semantic/**'");
    expect(workflow).toContain("- 'queries.yml'");
  });

  it('is blocking and uploads a per-run pass-rate report', async () => {
    const source = await readFile(workflowPath, 'utf8');
    const workflow = parse(source) as any;
    const steps = workflow.jobs['golden-eval'].steps as Array<Record<string, unknown>>;
    const runStep = steps.find((step) => step.name === 'Run blocking golden evaluation');
    const uploadStep = steps.find((step) => step.name === 'Upload pass-rate report');

    expect(source).not.toContain('continue-on-error');
    expect(runStep?.run).toBe('npm run eval:golden');
    expect(uploadStep?.uses).toBe('actions/upload-artifact@v4');
    expect((uploadStep?.with as Record<string, unknown>).name).toContain('${{ github.run_id }}');
    expect((uploadStep?.with as Record<string, unknown>).path).toBe('artifacts/golden-eval.json');
  });
});
