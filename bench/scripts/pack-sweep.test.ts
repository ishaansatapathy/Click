import { describe, expect, it } from 'vitest';

import type { ResultRow } from '../src/runner.js';
import { PACK_CASES, renderPackSweep, selectPackWinner, type PackResult } from './pack-sweep.js';

const row = (strict: number, p95ms = 100): ResultRow => ({
  runId: 'r', ts: '2026-11-16T00:00:00.000Z', gitSha: 'a', kind: 'retrieval', variant: 'V3',
  configHash: 'c', budget: 4_000, split: 'train', n: 2,
  metrics: { recallStrict: strict, recallAny: strict, symbolRecall: strict, precisionTokens: 0.5, p50ms: 50, p95ms },
  perType: {}, pruner: { none: 2 }, degraded: {},
});

describe('Prompt 137 pack sweep', () => {
  it('crosses all three strategies with prefix off/on exactly once', () => {
    expect(PACK_CASES.map((item) => item.name)).toEqual([
      'body-signature/prefix-off', 'body-signature/prefix-on',
      'body-only/prefix-off', 'body-only/prefix-on',
      'whole-file/prefix-off', 'whole-file/prefix-on',
    ]);
  });

  it('selects strict recall first and p95 on ties', () => {
    const results: PackResult[] = [
      { case: PACK_CASES[0]!, row: row(0.6, 120) },
      { case: PACK_CASES[1]!, row: row(0.7, 130) },
      { case: PACK_CASES[2]!, row: row(0.7, 110) },
    ];
    expect(selectPackWinner(results).case.name).toBe('body-only/prefix-off');
  });

  it('renders V1 alongside the V3 cases and the delivery decision', () => {
    const result = { case: PACK_CASES[0]!, row: row(0.6) };
    const rendered = renderPackSweep({ ...row(0.8), variant: 'V1' }, [result], result);
    expect(rendered).toContain('## V1 companion');
    expect(rendered).toContain('| V1 | chunk bodies |');
    expect(rendered).toContain('strategy=body-signature, prefix=off');
  });
});
