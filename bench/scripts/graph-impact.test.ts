import { describe, expect, it } from 'vitest';

import type { ResultRow, TaskDetail } from '../src/runner.js';
import { compareDetails, renderGraphImpact, selectLatest } from './graph-impact.js';

const result = (variant: string, budget: number, ts = '2026-01-01T00:00:00Z'): ResultRow => ({
  runId: `${variant}-${budget}-${ts}`, ts, gitSha: 'g', kind: 'retrieval', variant, configHash: 'c', budget, split: 'test', n: 2,
  metrics: { recallStrict: 0.5, recallAny: 0.5, symbolRecall: 0.4, precisionTokens: 0.2, p50ms: variant === 'V2' ? 10 : 20, p95ms: variant === 'V2' ? 15 : 30 },
  perType: { 'single-file': { n: 1, recallStrict: 1 }, 'multi-file': { n: 1, recallStrict: 0 }, 'multi-hop': { n: 1, recallStrict: 0.5 }, impact: { n: 1, recallStrict: 1 } },
  pruner: { none: 2 }, degraded: {},
});
const detail = (taskId: string, type: TaskDetail['type'], recallStrict: number): TaskDetail => ({
  taskId, type, recallStrict, recallAny: recallStrict, symbolRecall: recallStrict, precisionTokens: 0.1, latencyMs: 1,
  groundTruthFiles: [], missingGroundTruthFiles: [], items: [],
});

describe('graph impact report (PROMPT 143)', () => {
  it('selects the newest held-out row for a variant and budget', () => {
    expect(selectLatest([result('V3', 4_000), result('V3', 4_000, '2026-02-01T00:00:00Z')], 'V3', 4_000).ts).toContain('02-01');
    expect(() => selectLatest([], 'V2', 4_000)).toThrow('missing test row');
  });

  it('computes overall and separate multi-hop/impact paired intervals', () => {
    const a = [detail('a', 'multi-hop', 0), detail('b', 'impact', 0), detail('c', 'single-file', 1), detail('d', 'multi-file', 1)];
    const b = [detail('a', 'multi-hop', 1), detail('b', 'impact', 0.5), detail('c', 'single-file', 1), detail('d', 'multi-file', 1)];
    const comparisons = compareDetails(a, b, 4_000, 'V2', 'V3');
    expect(comparisons.find((value) => value.group === 'all')).toMatchObject({ n: 4, ci: { delta: 0.375 } });
    expect(comparisons.find((value) => value.group === 'multi-hop')).toMatchObject({ n: 1, ci: { delta: 1 } });
    expect(comparisons.find((value) => value.group === 'impact')).toMatchObject({ n: 1, ci: { delta: 0.5 } });
  });

  it('always renders V1 and labels latency as added versus V2', () => {
    const rows = [4_000, 8_000].flatMap((budget) => ['V1', 'V2', 'V3', 'V3r'].map((variant) => result(variant, budget)));
    const report = renderGraphImpact(rows, []);
    expect(report).toContain('| 4000 | V1 |');
    expect(report).toContain('Added p50 vs V2');
    expect(report).toContain('| 4000 | V3 | 20.0 | 30.0 | +10.0 | +15.0 |');
  });
});
