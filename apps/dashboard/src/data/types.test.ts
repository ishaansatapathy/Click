import { describe, expect, it } from 'vitest';
import { parseE2e } from './types.js';

const row = (variant: string, over: Record<string, unknown> = {}) => ({
  id: `r-${variant}`, variant, n: 8, solved: 2, tokensPerSolved: 100,
  totals: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, turns: 5, wallMs: 6, costUsd: 0.7 }, ...over,
});

describe('parseE2e', () => {
  it('accepts a run with both variants', () => {
    expect(parseE2e({ ts: 't', rows: [row('V0'), row('delivery')] }).rows).toHaveLength(2);
  });

  it('rejects anything that is not a two-variant run with numeric totals (the section then simply does not show)', () => {
    expect(() => parseE2e({ ts: 't', rows: [row('V0')] })).toThrow(/not an e2e document/);
    expect(() => parseE2e({ ts: 't', rows: [row('V0'), row('delivery', { totals: { turns: 1 } })] })).toThrow(/bad total/);
    expect(() => parseE2e(null)).toThrow();
  });
});
