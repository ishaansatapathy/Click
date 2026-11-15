import { describe, expect, it } from 'vitest';

import type { ResultRow } from '../src/runner.js';
import { SWEEP_CASES, renderSweep, selectWinner, type SweepResult } from './sweep.js';

const row = (strict: number, p95ms = 100): ResultRow => ({
  runId: 'r', ts: '2026-11-15T00:00:00.000Z', gitSha: 'a', kind: 'retrieval', variant: 'V3',
  configHash: 'c', budget: 4_000, split: 'train', n: 2,
  metrics: { recallStrict: strict, recallAny: strict, symbolRecall: strict, precisionTokens: 0.5, p50ms: 50, p95ms },
  perType: {}, pruner: { none: 2 }, degraded: {},
});

describe('Prompt 136 sweep', () => {
  it('contains each requested value once without rerunning duplicated defaults', () => {
    expect(SWEEP_CASES.map((item) => item.name)).toEqual([
      'default', 'alpha=0.3', 'alpha=0.5', 'seeds=4', 'seeds=16',
      'reverseScale=0.5', 'reverseScale=2', 'usePriors=off', 'symbolWeight=1', 'symbolWeight=2',
    ]);
  });

  it('selects only from train results, breaking recall ties by latency then name', () => {
    const results: SweepResult[] = [
      { case: SWEEP_CASES[0]!, row: row(0.5, 90) },
      { case: SWEEP_CASES[1]!, row: row(0.6, 120) },
      { case: SWEEP_CASES[2]!, row: row(0.6, 100) },
    ];
    expect(selectWinner(results).case.name).toBe('alpha=0.5');
  });

  it('renders the train table and one frozen test evaluation', () => {
    const result = { case: SWEEP_CASES[0]!, row: row(0.5) };
    const rendered = renderSweep([result], result, { ...row(0.4), split: 'test' });
    expect(rendered).toContain('Selection used only the train split');
    expect(rendered).toContain('| default |');
    expect(rendered).toContain('| test, 4k | 40.00% |');
  });
});
