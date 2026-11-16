import { describe, expect, it } from 'vitest';
import { learningSvg } from './chart.js';
import { prefixOf } from './learning-curve.js';

describe('learning curve', () => {
  it('learns from the first share of the log, in order', () => {
    expect(prefixOf([1, 2, 3, 4], 0)).toEqual([]);
    expect(prefixOf([1, 2, 3, 4], 0.5)).toEqual([1, 2]);
    expect(prefixOf([1, 2, 3, 4], 1)).toEqual([1, 2, 3, 4]);
  });

  it('draws one point per step, the baseline dashed, and says the outcomes are simulated', () => {
    const svg = learningSvg({ n: 75, budget: 4000, steps: [0, 0.5, 1].map((f, i) => ({ fraction: f, events: i * 79, strict: 0.77 + i * 0.005, runId: `r${i}` })) }, 0.7697);
    expect(svg.match(/<circle /g)).toHaveLength(3);
    expect(svg).toContain('stroke-dasharray');
    expect(svg).toContain('simulated outcomes');
    expect(svg).toContain('run r2');
  });
});
