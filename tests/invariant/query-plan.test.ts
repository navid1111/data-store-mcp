/**
 * Architecture invariants 1 and 2 (architecture.md §7).
 *
 * These are repo-wide structural rules, not behaviour. They exist because the
 * governance gate is only non-bypassable if there is no *other* route from a
 * tool to a driver — and that is a property of the whole tree, which no single
 * unit test can observe.
 *
 * A static scan is the right tool here despite its bluntness: the failure mode
 * being guarded against is a future contributor adding a plausible-looking
 * shortcut, and that shows up as a new call site.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path),
  text: readFileSync(path, 'utf8'),
}));

const inGovernance = (path: string) => path.split(sep)[0] === 'governance';

describe('invariant 2: only governance constructs an executable plan', () => {
  it('finds no createQueryPlan call outside src/governance/', () => {
    const offenders = files
      .filter((f) => !inGovernance(f.path))
      .filter((f) => /\bcreateQueryPlan\s*\(/.test(f.text))
      .map((f) => f.path);

    expect(offenders).toEqual([]);
  });

  it('finds no cast that forges a plan', () => {
    // A double cast is the one escape hatch the brands cannot
    // close, so it is banned by convention and checked here.
    const offenders = files
      .filter((f) => !inGovernance(f.path))
      .filter((f) => /as\s+unknown\s+as\s+(?:MongoQueryPlan|QueryPlan)/.test(f.text))
      .map((f) => f.path);

    expect(offenders).toEqual([]);
  });

  it('confirms the scan can actually see the factory', () => {
    // Guards the premise: if createQueryPlan were renamed, the tests above
    // would pass vacuously.
    const definers = files.filter((f) => /export function createQueryPlan/.test(f.text));
    expect(definers.map((f) => f.path)).toEqual([join('governance', 'plan.ts')]);
  });
});

describe('invariant 1: no tool passes a string to a driver', () => {
  const toolFiles = files.filter((f) => f.path.startsWith(join('mcp', 'tools')));

  it('finds tool files to check', () => {
    expect(toolFiles.length).toBeGreaterThan(0);
  });

  // query() takes a string and applies no governance; it exists for
  // internally-generated introspection SQL only. A tool reaching it with
  // agent input would be an ungoverned path to the driver.
  //
  it('finds no tool calling the raw query() path', () => {
    const offenders = toolFiles
      .filter((f) => /\bdb\.query\s*\(|\bdatabase\.query\s*\(/.test(f.text))
      .map((f) => f.path);

    expect(offenders).toEqual([]);
  });

  it('routes SQL sources through the gate', () => {
    const queryTool = toolFiles.find((f) => f.path.endsWith(join('tools', 'query.ts')))!;
    expect(queryTool.text).toMatch(/buildPlan\(/);
    expect(queryTool.text).toMatch(/db\.execute\(/);
  });

  it('routes MongoDB through its gate and branded execute path', () => {
    const queryTool = toolFiles.find((f) => f.path.endsWith(join('tools', 'query.ts')))!;
    expect(queryTool.text).toMatch(/buildMongoPlan\(/);
    expect(queryTool.text).toMatch(/db\.execute\(plan(?:,|\))/);
  });
});
