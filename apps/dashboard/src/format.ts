import type { DiffRow, ResultsData, RunRow } from './data/types.js';

/** 0.7697 -> "77.0" (percent, one decimal). */
export const pct = (x: number, digits = 1): string => (x * 100).toFixed(digits);

/** A difference in percentage points with an explicit sign: +4.0 / 0.0 / −1.6. */
export const pp = (x: number, digits = 1): string => {
  const v = Number((x * 100).toFixed(digits));
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
};
export const ms = (x: number): string => `${Math.round(x)} ms`;
export const budgetLabel = (b: number): string => `${b / 1000}k`;

export function row(d: ResultsData, variant: string, budget: number): RunRow {
  const r = d.rows.find((x) => x.variant === variant && x.budget === budget);
  if (!r) throw new Error(`results.json has no ${variant} row at ${budget} tokens`);
  return r;
}

export function diffOf(d: ResultsData, label: string, budget: number, group = 'all'): DiffRow {
  const r = d.diffs.find((x) => x.label === label && x.budget === budget && x.group === group);
  if (!r) throw new Error(`results.json has no difference "${label}" at ${budget} tokens for ${group}`);
  return r;
}

/** Does the 95% interval exclude zero? */
export const excludesZero = (d: DiffRow): boolean => d.lo > 0 || d.hi < 0;

export const ci = (d: DiffRow): string => `${pp(d.delta)} pp [${pp(d.lo)}, ${pp(d.hi)}]`;
