import { describe, expect, it } from 'vitest';

import type { ResultRow, TaskDetail } from './runner.js';
import { compareRuns, renderRunDiff, resolveRun } from './diff.js';

function row(runId: string, variant: string, ts: string): ResultRow {
  return {
    runId, variant, ts, gitSha: 'abc', kind: 'retrieval', configHash: 'cfg', budget: 4_000, split: 'test', n: 2,
    metrics: { recallStrict: 0, recallAny: 0, precisionTokens: 0, p50ms: 1, p95ms: 1 },
    perType: {}, pruner: {}, degraded: {},
  };
}

function detail(taskId: string, recall: number, missing: string[], reason: string): TaskDetail {
  return {
    taskId, type: 'impact', recallStrict: recall, recallAny: recall, symbolRecall: null, precisionTokens: 0,
    latencyMs: 1, groundTruthFiles: ['src/ground.ts'], missingGroundTruthFiles: missing,
    items: [{ nodeId: 'file:src/other.ts', path: 'src/other.ts', name: 'other.ts', mode: 'file', tokens: 10, reasons: [reason] }],
  };
}

describe('benchmark diff', () => {
  it('resolves exact run IDs before the latest matching variant', () => {
    const rows = [row('run-1', 'V3', '2026-01-01T00:00:00Z'), row('run-2', 'V3', '2026-01-02T00:00:00Z')];
    expect(resolveRun(rows, 'run-1').runId).toBe('run-1');
    expect(resolveRun(rows, 'V3').runId).toBe('run-2');
  });

  it('pairs by task ID and ranks wins and losses with missing files and reasons', () => {
    const a = row('a', 'V2', '2026-01-01T00:00:00Z');
    const b = row('b', 'V3', '2026-01-02T00:00:00Z');
    const result = compareRuns(a, b,
      [detail('h-01', 0, ['src/ground.ts'], 'lexical A'), detail('h-02', 1, [], 'graph A'), detail('h-03', 1, [], 'only A')],
      [detail('h-01', 1, [], 'graph B'), detail('h-02', 0, ['src/ground.ts'], 'semantic B')],
    );
    expect(result).toMatchObject({ pairedTasks: 2, wins: [{ taskId: 'h-01', delta: 1 }], losses: [{ taskId: 'h-02', delta: -1 }] });
    expect(result.losses[0]?.replacementReasonsB).toEqual(['semantic B']);
    const output = renderRunDiff(result);
    expect(output).toContain('missing B: src/ground.ts');
    expect(output).toContain('replacement reasons B: semantic B');
  });
});
