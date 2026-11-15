import { forest, groupedBars } from '../charts.js';
import { h, html } from '../dom.js';
import { budgetLabel, pct, pp } from '../format.js';
import type { Page } from '../app.js';

const short = (key: string): string => {
  const [from, kind, to] = key.split('|');
  const name = (id: string | undefined): string => (id ?? '').replace(/^(file|sym):/, '').replace(/^src\//, '');
  return `${name(from)} —${kind}→ ${name(to)}`;
};

export const learning: Page = ({ data }) => {
  const l = data.learning;
  if (!l) return h('div', { class: 'callout' }, 'learning.json is not part of this build.');
  const bars = [4000, 8000].map((b) => ({
    label: `${budgetLabel(b)} token budget`,
    bars: ['V3', 'V5'].flatMap((v) => {
      const x = l.rows.find((r) => r.variant === v && r.budget === b);
      return x ? [{ label: v === 'V3' ? 'V3 (static)' : 'V5 (learned)', value: x.strict, cls: `v-${v}`, title: `${v} at ${b} tokens: ${pct(x.strict)}% (run ${x.rowId})` }] : [];
    }),
  }));
  const rows = l.diffs.map((d) => ({ d, label: `V5 − V3 · ${budgetLabel(d.budget)} · ${d.group === 'all' ? 'all tasks' : d.group} (n=${d.n})` }));
  const headline = l.diffs.find((d) => d.group === 'all' && d.budget === 4000);
  const table = (title: string, list: { key: string; w: number }[]): HTMLElement =>
    h('div', { class: 'card' }, h('h3', {}, title), h('table', {}, h('tbody', {}, list.map((e) => h('tr', {}, h('td', {}, h('code', { class: 'small' }, short(e.key))), h('td', { class: 'num' }, `×${e.w.toFixed(2)}`))))));

  return h(
    'div',
    {},
    h('h1', {}, 'Learning'),
    h('p', { class: 'lead muted' }, 'Click watches which packed code the agent actually used, and nudges the weight of the graph edges that led to it. The weights are a small document; the graph walk reads them on the next request.'),
    h(
      'div',
      { class: 'flow' },
      h('div', { class: 'step' }, h('b', {}, 'Serve'), 'getContext packs code and remembers, for every item, the chain of edges that put it there.'),
      h('div', { class: 'step' }, h('b', {}, 'Observe'), 'After the turn, a Stop hook reads the transcript: which packed items did the agent read or edit, which did it ignore, which files did it open that we never sent?'),
      h('div', { class: 'step' }, h('b', {}, 'Check'), 'A background check (type-check, tests) says whether the change worked; unknown stays unknown.'),
      h('div', { class: 'step hydra' }, h('b', {}, 'Derive'), 'Edges on the path of used items are reinforced, edges that led to ignored items decay, and files the agent opened anyway become new co-change edges. Stored with the graph.'),
      h('div', { class: 'step' }, h('b', {}, 'Apply'), 'The next request multiplies edge weights by what was learned. A rollback copy is kept.'),
    ),
    h('div', { class: 'callout' }, h('b', {}, 'Honest status. '), `These results come from outcomes simulated from the benchmark's own answers (${l.events} events), not from real agent sessions. They show the loop works and moves the numbers a little. They do not yet show that it pays off for a real team. ${headline ? `At ${budgetLabel(headline.budget)} the held-out gain is ${pp(headline.delta)} pp with a 95% interval of [${pp(headline.lo)}, ${pp(headline.hi)}], which includes zero.` : ''}`),

    h('h2', {}, 'V5 (learned) against V3 (static), held-out tasks'),
    h('div', { class: 'card' }, html(groupedBars(bars, { label: 'V3 versus V5 strict recall' }))),
    h('div', { class: 'card', style: 'margin-top:16px' }, html(forest(rows, { label: 'V5 minus V3 differences' }))),

    h('h2', {}, `What was learned (weights ${l.weightsVersion})`),
    h('p', { class: 'muted' }, `${l.events} outcome events produced ${l.multipliers} edge multipliers and ${l.learnedEdges} new co-change edges, bounded between ×0.1 and ×5 so one bad session cannot dominate.`),
    h('div', { class: 'grid two' }, table('Strongest reinforced edges', l.topUp), table('Most decayed edges', l.topDown)),
    h('p', { class: 'small muted' }, 'Some of the strongest multipliers sit on a handful of edges of one small file, which is what a short simulated history looks like. Treat this table as a demonstration of the mechanism.'),
  );
};
