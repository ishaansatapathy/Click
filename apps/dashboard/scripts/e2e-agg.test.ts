import { describe, expect, it } from 'vitest';
import { aggregateE2e, type RawE2eRow } from './e2e-agg.js';

const row = (runId: string, variant: string, solved: boolean, over: Partial<RawE2eRow> = {}): RawE2eRow => ({
  runId, taskId: 't', variant, solved, usage: { input: 10, output: 100, cacheRead: 1000, cacheCreation: 50 }, turns: 5, costUsd: 0.1, wallMs: 20_000, ...over,
});

describe('aggregateE2e', () => {
  it('sums every graded run per variant and divides all tokens by the solved tasks', () => {
    const d = aggregateE2e([row('r1', 'V0', true), row('r1', 'delivery', true), row('r2', 'V0', false), row('r2', 'delivery', true)], 't')!;
    expect(d.runs).toEqual(['r1', 'r2']);
    const v0 = d.rows.find((r) => r.variant === 'V0')!;
    expect(v0).toMatchObject({ n: 2, solved: 1, tokensPerSolved: 320, totals: { turns: 10, outputTokens: 200 } });
    expect(d.rows.find((r) => r.variant === 'delivery')).toMatchObject({ n: 2, solved: 2, tokensPerSolved: 160 });
  });

  it('leaves out runs whose check never ran, and says null when a variant solved nothing', () => {
    const d = aggregateE2e([row('r1', 'V0', false), row('r1', 'V0', true, { gradeError: true }), row('r1', 'delivery', true)], 't')!;
    expect(d.rows.find((r) => r.variant === 'V0')).toMatchObject({ n: 1, solved: 0, tokensPerSolved: null });
  });

  it('has nothing to show unless both variants were run', () => {
    expect(aggregateE2e([row('r1', 'V0', true)], 't')).toBeNull();
    expect(aggregateE2e([], 't')).toBeNull();
  });
});
