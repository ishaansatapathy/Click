import { forest, recallChart } from '../charts.js';
import { h, html } from '../dom.js';
import { budgetLabel, ci, ms, pct } from '../format.js';
import type { DiffRow } from '../data/types.js';
import type { Page } from '../app.js';
import { legend } from './overview.js';

const TYPES = ['single-file', 'multi-file', 'multi-hop', 'impact'];

export const benchmark: Page = ({ data }) => {
  const r = data.results;
  const variants = ['random', 'V1', 'V2', 'V3', 'V3r', 'V5', 'oracle'];
  const rowsFor = (budget: number): HTMLElement[] =>
    variants.flatMap((v) => {
      const x = r.rows.find((y) => y.variant === v && y.budget === budget);
      return x
        ? [
            h(
              'tr',
              {},
              h('td', {}, v),
              h('td', { class: 'num' }, `${pct(x.strict)}`),
              h('td', { class: 'num' }, `${pct(x.any)}`),
              h('td', { class: 'num' }, x.symbol === null ? '–' : pct(x.symbol)),
              h('td', { class: 'num' }, pct(x.precision)),
              h('td', { class: 'num' }, x.p50ms ? ms(x.p50ms) : '–'),
              h('td', { class: 'num' }, x.p95ms ? ms(x.p95ms) : '–'),
              h('td', { class: 'num' }, `${x.n} ${x.split}`),
              h('td', {}, h('code', { class: 'small' }, x.id)),
            ),
          ]
        : [];
    });

  const forestFor = (budget: number, labels: string[], group: string): { d: DiffRow; label: string }[] =>
    labels.flatMap((l) => {
      const d = r.diffs.find((x) => x.budget === budget && x.label === l && x.group === group);
      return d ? [{ d, label: `${l} (${group === 'all' ? 'all tasks' : group}, n=${d.n})` }] : [];
    });

  const typeTable = (budget: number): HTMLElement => {
    const cols = ['V1', 'V2', 'V3', 'V5'];
    return h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, `${budgetLabel(budget)} budget · strict recall %`), ...cols.map((c) => h('th', { class: 'num' }, c)))),
        h(
          'tbody',
          {},
          TYPES.map((t) => {
            const cells = cols.map((c) => {
              const run = r.rows.find((x) => x.variant === c && x.budget === budget);
              const v = run ? r.perType.find((p) => p.rowId === run.id && p.type === t) : undefined;
              return h('td', { class: 'num' }, v ? `${pct(v.strict)}` : '–');
            });
            const n = r.perType.find((p) => p.type === t && p.rowId === r.rows.find((x) => x.variant === 'V3' && x.budget === budget)?.id)?.n;
            return h('tr', {}, h('td', {}, `${t} `, h('span', { class: 'muted small' }, n ? `(n=${n})` : '')), ...cells);
          }),
        ),
      ),
    );
  };

  return h(
    'div',
    {},
    h('h1', {}, 'Benchmark'),
    h(
      'p',
      { class: 'lead muted' },
      `${r.tasks.total} tasks from the git history of ${r.repo.name} (${r.tasks.train} to tune on, ${r.tasks.test} held out and never tuned on). Each task is a real commit: its message, rewritten as a request, is the input; the files that commit changed are the answer.`,
    ),
    h('h2', {}, 'What is measured'),
    h(
      'p',
      {},
      h('b', {}, 'Strict file recall'),
      ': the share of the files the real commit changed whose code ended up inside the packed context, within a fixed token budget. A file that is only named, or shown as a signature, does not count. Because the budget is fixed, a variant cannot win by sending more; it has to send the right things. ',
      h('b', {}, 'Symbol recall'),
      ' asks the same of the individual functions and components that changed.',
    ),
    h('h2', {}, 'Recall by variant'),
    h('div', { class: 'card' }, html(recallChart(r.rows, ['random', 'V1', 'V2', 'V3', 'V3r', 'V5', 'oracle'], [4000, 8000])), legend(['random', 'V1', 'V2', 'V3', 'V3r', 'V5', 'oracle'])),

    h('h2', {}, 'Does the graph help? Differences with 95% intervals'),
    h('p', { class: 'muted' }, `Paired bootstrap over the same tasks (${r.bootstrap.iterations.toLocaleString()} resamples, seed ${r.bootstrap.seed}). Green or red means the interval excludes zero; grey means we cannot tell it apart from no difference.`),
    ...[4000, 8000].map((b) =>
      h(
        'div',
        { class: 'card', style: 'margin-bottom:16px' },
        h('h3', {}, `${budgetLabel(b)} token budget`),
        html(forest([...forestFor(b, ['V3 - V2'], 'all'), ...forestFor(b, ['V3 - V2'], 'multi-hop'), ...forestFor(b, ['V3 - V2'], 'impact'), ...forestFor(b, ['V3 - V1'], 'all'), ...forestFor(b, ['V3 - V1'], 'impact'), ...forestFor(b, ['V3r - V3'], 'all')], { label: `Differences at ${b} tokens` })),
        h('p', { class: 'small muted' }, 'V3 − V2: what the graph adds. V3 − V1: against plain vector search over chunks. V3r − V3: reading the graph from the local replica instead of HydraDB (measures what the network round trip costs in accuracy, not speed).'),
      ),
    ),
    h('div', { class: 'callout info' }, h('b', {}, 'Read the impact rows with care. '), `Only ${r.tasks.byType['impact'] ?? 0} impact tasks exist in all and ${r.diffs.find((d) => d.group === 'impact')?.n ?? 0} are in the held-out split, so those intervals are wide even when they exclude zero. The all-tasks rows are the ones to lean on.`),

    h('h2', {}, 'By task type'),
    h('div', { class: 'grid two' }, typeTable(4000), typeTable(8000)),

    h('h2', {}, 'All headline runs'),
    h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ...['variant', 'strict %', 'any %', 'symbol %', 'precision %', 'p50', 'p95', 'tasks', 'run id'].map((c, i) => h('th', { class: i > 0 && i < 8 ? 'num' : '' }, c)))), h('tbody', {}, h('tr', {}, h('td', { colspan: 9, class: 'muted small' }, 'Budget: 4,000 tokens')), rowsFor(4000), h('tr', {}, h('td', { colspan: 9, class: 'muted small' }, 'Budget: 8,000 tokens')), rowsFor(8000)))),
    h('p', { class: 'small muted' }, 'Latency is end to end on one laptop, including the HydraDB round trip for V3 and V5. Oracle and random are references, not systems: the oracle packs the true files; random packs random ones.'),
    h(
      'div',
      { class: 'callout' },
      h('b', {}, 'Where the graph costs time. '),
      `V3's median request takes about ${ms(r.rows.find((x) => x.variant === 'V3' && x.budget === 4000)!.p50ms)} against ${ms(r.rows.find((x) => x.variant === 'V2' && x.budget === 4000)!.p50ms)} without the graph; the neighbourhood query to HydraDB is most of the difference. If HydraDB misses its deadline the request is served from a local replica instead and says so (flag graph-replica); fallbacks in these runs: ${r.rows.filter((x) => x.variant === 'V3' || x.variant === 'V5').map((x) => x.graphFallback).join(', ')}.`,
    ),
    h('p', { class: 'small muted' }, `Reproduce: clone the repo, run the benchmark runner against bench/repo at commit ${r.repo.sha.slice(0, 7)}; ${ci(r.diffs.find((d) => d.label === 'V3 - V2' && d.group === 'all' && d.budget === 4000)!)} is the headline difference.`),
  );
};
