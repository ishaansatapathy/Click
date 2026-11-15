// Charts are pure functions from numbers to an SVG string, styled by CSS classes (so light and dark themes just work) and
// tested without a browser. Each mark carries a <title> with its exact value: the tooltip and the screen-reader text.

import type { DiffRow, RunRow } from './data/types.js';
import { esc } from './dom.js';
import { budgetLabel, pct, pp } from './format.js';

export interface Bar {
  label: string;
  value: number;
  cls: string;
  title: string;
}
export interface BarGroup {
  label: string;
  bars: Bar[];
}

/** Grouped vertical bars on a 0..1 scale. */
export function groupedBars(groups: BarGroup[], opts: { width?: number; height?: number; label: string }): string {
  const W = opts.width ?? 720;
  const H = opts.height ?? 300;
  const m = { l: 44, r: 12, t: 20, b: 56 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const y = (v: number): number => m.t + ih * (1 - Math.max(0, Math.min(1, v)));
  const parts: string[] = [];
  for (let t = 0; t <= 1.0001; t += 0.25) {
    parts.push(`<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="tick" x="${m.l - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${Math.round(t * 100)}</text>`);
  }
  const gw = iw / Math.max(1, groups.length);
  groups.forEach((g, gi) => {
    const pad = gw * 0.08;
    const bw = (gw - pad * 2) / Math.max(1, g.bars.length);
    g.bars.forEach((b, bi) => {
      const x = m.l + gi * gw + pad + bi * bw;
      const top = y(b.value);
      parts.push(
        `<g class="bar ${esc(b.cls)}"><title>${esc(b.title)}</title><rect x="${(x + 1).toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${Math.max(0, m.t + ih - top).toFixed(1)}" rx="2"/><text class="val" x="${(x + bw / 2).toFixed(1)}" y="${(top - 4).toFixed(1)}" text-anchor="middle">${pct(b.value, 0)}</text></g>`,
      );
      parts.push(`<text class="tick" x="${(x + bw / 2).toFixed(1)}" y="${H - m.b + 16}" text-anchor="middle">${esc(b.label)}</text>`);
    });
    parts.push(`<text class="group" x="${(m.l + gi * gw + gw / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle">${esc(g.label)}</text>`);
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label)}" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
}

/** Strict file recall by variant, one group per token budget. */
export function recallChart(rows: RunRow[], variants: string[], budgets: number[]): string {
  const groups = budgets.map((b) => ({
    label: `${budgetLabel(b)} token budget`,
    bars: variants.flatMap((v) => {
      const r = rows.find((x) => x.variant === v && x.budget === b);
      return r ? [{ label: v, value: r.strict, cls: `v-${v}`, title: `${v} at ${b} tokens: ${pct(r.strict)}% strict file recall (n=${r.n}, run ${r.id})` }] : [];
    }),
  }));
  return groupedBars(groups, { label: 'Strict file recall by variant and token budget' });
}

/** A forest plot: each row is a difference in percentage points with its 95% interval; the solid line is "no difference". */
export function forest(rows: { d: DiffRow; label: string }[], opts: { width?: number; rowH?: number; label: string }): string {
  const W = opts.width ?? 720;
  const rh = opts.rowH ?? 34;
  const m = { l: 220, r: 24, t: 14, b: 30 };
  const H = m.t + m.b + rows.length * rh;
  const lo = Math.min(-0.05, ...rows.map((r) => r.d.lo));
  const hi = Math.max(0.05, ...rows.map((r) => r.d.hi));
  const span = hi - lo;
  const x = (v: number): number => m.l + ((v - lo) / span) * (W - m.l - m.r);
  const parts: string[] = [];
  const step = span > 0.5 ? 0.2 : span > 0.2 ? 0.1 : 0.05;
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) {
    parts.push(`<line class="grid" x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${m.t}" y2="${H - m.b}"/><text class="tick" x="${x(t).toFixed(1)}" y="${H - 10}" text-anchor="middle">${pp(t, 0)}</text>`);
  }
  parts.push(`<line class="zero" x1="${x(0).toFixed(1)}" x2="${x(0).toFixed(1)}" y1="${m.t}" y2="${H - m.b}"/>`);
  rows.forEach(({ d, label }, i) => {
    const cy = m.t + i * rh + rh / 2;
    const sig = d.lo > 0 || d.hi < 0;
    const cls = sig ? (d.delta > 0 ? 'pos' : 'neg') : 'flat';
    parts.push(
      `<g class="ci ${cls}"><title>${esc(`${label}: ${pp(d.delta)} pp, 95% interval ${pp(d.lo)} to ${pp(d.hi)} (n=${d.n})`)}</title><text class="rowlabel" x="${m.l - 12}" y="${(cy + 4).toFixed(1)}" text-anchor="end">${esc(label)}</text><line class="whisker" x1="${x(d.lo).toFixed(1)}" x2="${x(d.hi).toFixed(1)}" y1="${cy}" y2="${cy}"/><circle cx="${x(d.delta).toFixed(1)}" cy="${cy}" r="5"/></g>`,
    );
  });
  return `<svg class="chart forest" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label)}" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
}
