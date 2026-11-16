import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { generateReadmeTables, replaceMarkedSection } from './readme-tables.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const retrieval = (variant: string, budget: number, strict = 0.75) => ({
  runId: `${variant}-${budget}`, kind: 'retrieval', variant, budget, split: 'test',
  metrics: { recallStrict: strict, symbolRecall: strict - 0.1, p50ms: 100, p95ms: 200 },
});

function rows(): Record<string, unknown>[] {
  const retrievals = ['V1', 'V2', 'V3', 'V3r', 'V5'].flatMap((variant) => [retrieval(variant, 4_000), retrieval(variant, 8_000, 0.8)]);
  const task = { taskId: 't1', inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40, turns: 2, wallMs: 1_500, passed: false };
  return [
    ...retrievals,
    { runId: 'latency-1', kind: 'latency', variant: 'hook', n: 20, metrics: { p50ms: 123, p95ms: 456 } },
    { runId: 'e2e-v0', kind: 'e2e', variant: 'V0', n: 1, solved: 0, tokensPerSolved: null, totals: { inputTokens: 10, outputTokens: 20 }, tasks: [task] },
    { runId: 'e2e-click', kind: 'e2e', variant: 'delivery', n: 1, solved: 0, tokensPerSolved: null, totals: { inputTokens: 8, outputTokens: 18 }, tasks: [task] },
  ];
}

describe('README benchmark tables (PROMPT 200)', () => {
  it('changes only marker bodies and is byte-identical on a second run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'click-readme-tables-'));
    dirs.push(dir);
    const results = join(dir, 'results.jsonl');
    const readme = join(dir, 'README.md');
    writeFileSync(results, `${rows().map((row) => JSON.stringify(row)).join('\n')}\n`);
    writeFileSync(readme, 'before\n<!-- bench:recall:start -->\nold\n<!-- bench:recall:end -->\nmiddle\n<!-- bench:latency:start -->\nold\n<!-- bench:latency:end -->\n<!-- bench:e2e:start -->\nold\n<!-- bench:e2e:end -->\nafter\n');
    await generateReadmeTables(results, readme);
    const once = readFileSync(readme, 'utf8');
    expect(once.startsWith('before\n<!-- bench:recall:start -->')).toBe(true);
    expect(once.endsWith('<!-- bench:e2e:end -->\nafter\n')).toBe(true);
    expect(once).toContain('| V3 | 75.0% | 65.0% | 80.0% | 70.0% |');
    expect(once).toContain('| `t1` | delivery | no | 10 | 20 | 30 | 40 | 2 | 1.5 s |');
    await generateReadmeTables(results, readme);
    expect(readFileSync(readme, 'utf8')).toBe(once);
  });

  it('fails on missing source rows or malformed marker pairs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'click-readme-tables-'));
    dirs.push(dir);
    const results = join(dir, 'results.jsonl');
    const readme = join(dir, 'README.md');
    writeFileSync(results, `${JSON.stringify(retrieval('V1', 4_000))}\n`);
    writeFileSync(readme, '<!-- bench:recall:start -->\n<!-- bench:recall:end -->\n');
    await expect(generateReadmeTables(results, readme)).rejects.toThrow(/Missing benchmark row/);
    expect(() => replaceMarkedSection('outside', 'recall', 'body')).toThrow(/marker pair missing/);
  });
});
