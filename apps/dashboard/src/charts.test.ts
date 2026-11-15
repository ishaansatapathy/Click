import { describe, expect, it } from 'vitest';
import { forest, groupedBars, recallChart } from './charts.js';
import type { DiffRow, RunRow } from './data/types.js';
import { excludesZero, pct, pp } from './format.js';

const diff = (delta: number, lo: number, hi: number): DiffRow => ({ budget: 4000, label: 'V3 - V2', a: 'V3', b: 'V2', aRow: 'a', bRow: 'b', group: 'all', n: 75, delta, lo, hi });
const run = (variant: string, budget: number, strict: number): RunRow => ({ id: `${variant}-${budget}`, variant, budget, split: 'test', n: 75, strict, any: strict, symbol: null, precision: 0.1, p50ms: 1, p95ms: 2, graphFallback: 0, ts: '' });

describe('number formatting', () => {
  it('writes percentages and signed percentage-point differences', () => {
    expect(pct(0.7697)).toBe('77.0');
    expect(pp(0.0404)).toBe('+4.0');
    expect(pp(-0.016)).toBe('−1.6');
    expect(pp(-0.0001)).toBe('0.0'); // a difference that rounds to zero carries no sign
  });
  it('knows when an interval excludes zero', () => {
    expect(excludesZero(diff(0.04, 0.017, 0.067))).toBe(true);
    expect(excludesZero(diff(0.01, -0.013, 0.043))).toBe(false);
  });
});

describe('charts', () => {
  it('draws one bar per variant and budget, each with its exact value as a tooltip', () => {
    const svg = recallChart([run('V2', 4000, 0.73), run('V3', 4000, 0.77)], ['V2', 'V3'], [4000]);
    expect(svg.match(/class="bar /g)).toHaveLength(2);
    expect(svg).toContain('V3 at 4000 tokens: 77.0% strict file recall (n=75, run V3-4000)');
  });
  it('clamps bar heights into the plot, so a bad value cannot draw outside it', () => {
    const svg = groupedBars([{ label: 'g', bars: [{ label: 'x', value: 3, cls: 'v-V1', title: 't' }] }], { label: 'c' });
    expect(svg).not.toMatch(/height="-/);
  });
  it('colours an interval by whether it excludes zero', () => {
    const svg = forest([{ d: diff(0.04, 0.017, 0.067), label: 'better' }, { d: diff(0.0, -0.06, 0.06), label: 'inconclusive' }, { d: diff(-0.05, -0.08, -0.02), label: 'worse' }], { label: 'x' });
    expect(svg).toContain('class="ci pos"');
    expect(svg).toContain('class="ci flat"');
    expect(svg).toContain('class="ci neg"');
  });
  it('escapes labels', () => {
    expect(forest([{ d: diff(0.01, 0, 0.02), label: '<img onerror=x>' }], { label: 'x' })).not.toContain('<img');
  });
});
