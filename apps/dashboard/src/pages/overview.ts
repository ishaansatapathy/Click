import { recallChart } from '../charts.js';
import { h, html } from '../dom.js';
import { budgetLabel, ci, diffOf, excludesZero, ms, pct, pp, row } from '../format.js';
import type { Page } from '../app.js';

export const overview: Page = ({ data }) => {
  const r = data.results;
  const v1 = row(r, 'V1', 4000);
  const v2 = row(r, 'V2', 4000);
  const v3 = row(r, 'V3', 4000);
  const v3at8 = row(r, 'V3', 8000);
  const v2at8 = row(r, 'V2', 8000);
  const oracle = row(r, 'oracle', 4000);
  const random = row(r, 'random', 4000);
  const graph4 = diffOf(r, 'V3 - V2', 4000);
  const graph8 = diffOf(r, 'V3 - V2', 8000);
  const impact = diffOf(r, 'V3 - V2', 4000, 'impact');
  const hop8 = diffOf(r, 'V3 - V2', 8000, 'multi-hop');
  const vs1 = diffOf(r, 'V3 - V1', 4000);
  const learn = data.learning?.diffs.find((d) => d.budget === 4000 && d.group === 'all');
  const lat = v3.p95ms - v2.p95ms;

  return h(
    'div',
    {},
    h(
      'section',
      { class: 'hero' },
      h('h1', {}, 'Give the agent the right code, not the whole repo.'),
      h(
        'p',
        { class: 'lead' },
        'Click is a context layer for coding agents on Vue 3 projects. One function, ',
        h('code', {}, 'getContext(task, budget)'),
        ', returns the few functions, components and stores a task needs, found by walking a code graph kept in a self-hosted HydraDB and packed into a token budget. It runs as a local daemon your agent reaches through a hook or MCP.',
      ),
      h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/try' }, 'Try it in your browser'), h('a', { class: 'btn', href: '#/benchmark' }, 'See the numbers'), h('a', { class: 'btn', href: 'https://github.com/ishaansatapathy/Click' }, 'Source on GitHub')),
    ),

    h('h2', {}, 'The three questions this was built to answer'),
    h(
      'div',
      { class: 'grid three' },
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'q' }, '1 · Do we measure what matters?'),
        h('div', { class: 'stat' }, `${pct(v3.strict)}%`, h('small', {}, ` of the files an engineer changed, in ${budgetLabel(4000)} tokens`)),
        h(
          'p',
          { class: 'small muted' },
          `Strict file recall on ${v3.n} held-out tasks mined from ${r.repo.name}'s own history (${r.tasks.total} tasks in all). A file only counts if its code is in the packed context, not merely named. The ceiling (oracle) is ${pct(oracle.strict)}%; picking files at random gets ${pct(random.strict)}%.`,
        ),
      ),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'q' }, '2 · Is HydraDB doing real work?'),
        h('div', { class: `stat ${excludesZero(graph8) ? 'pos' : ''}` }, `${pp(graph8.delta)} pp`, h('small', {}, ` at ${budgetLabel(8000)} vs the same pipeline without the graph`)),
        h(
          'p',
          { class: 'small muted' },
          `95% interval [${pp(graph8.lo)}, ${pp(graph8.hi)}]; at ${budgetLabel(4000)} it is ${ci(graph4)}. On impact questions ("what else must change?") the graph adds ${pp(impact.delta)} pp, and on multi-hop tasks ${pp(hop8.delta)} pp at ${budgetLabel(8000)}. The price is latency: about ${ms(lat)} more at p95.`,
        ),
      ),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'q' }, '3 · Does it actually learn?'),
        h('div', { class: 'stat flat' }, learn ? `${pp(learn.delta)} pp` : 'n/a', h('small', {}, ' from learned edge weights')),
        h(
          'p',
          { class: 'small muted' },
          learn
            ? `Small and not yet distinguishable from zero (95% interval [${pp(learn.lo)}, ${pp(learn.hi)}]), measured on outcomes simulated from the benchmark, not on real agent sessions. The mechanism works end to end; the evidence that it pays off is thin, and we say so.`
            : 'Learning data is not available in this build.',
        ),
      ),
    ),

    h('h2', {}, 'Strict file recall by variant'),
    h('div', { class: 'card' }, html(recallChart(r.rows, ['random', 'V1', 'V2', 'V3', 'V5', 'oracle'], [4000, 8000])), legend(['random', 'V1', 'V2', 'V3', 'V5', 'oracle'])),
    h(
      'p',
      { class: 'small muted' },
      `${v3.n} held-out tasks. V1 = vector search over code chunks. V2 = Click's seeds (symbols + BM25 + embeddings) with no graph. V3 = V2 plus the HydraDB graph walk. V5 = V3 plus learned weights. Every bar is one row of bench/results.jsonl; hover for its run id.`,
    ),

    h('h2', {}, 'What we claim, and what we do not'),
    h(
      'div',
      { class: 'grid two' },
      h(
        'div',
        { class: 'card' },
        h('h3', {}, 'Supported by the data'),
        h(
          'ul',
          {},
          h('li', {}, `The graph helps. V3 beats the identical pipeline without it by ${ci(graph4)} at ${budgetLabel(4000)} and ${ci(graph8)} at ${budgetLabel(8000)}; both intervals exclude zero.`),
          h('li', {}, `Symbol-level recall is ${pct(v3.symbol ?? 0, 0)}% for V3 against ${pct(v1.symbol ?? 0, 0)}% for chunked vector search (V1). Click returns the function that matters, not a slice of a file.`),
          h('li', {}, `At ${budgetLabel(8000)} V3 reaches ${pct(v3at8.strict)}% against ${pct(v2at8.strict)}% without the graph, because the graph keeps finding useful files when the budget grows.`),
        ),
      ),
      h(
        'div',
        { class: 'card' },
        h('h3', {}, 'Not (yet) supported'),
        h(
          'ul',
          {},
          h('li', {}, `File recall against plain vector search is a tie: V3 minus V1 is ${ci(vs1)}. The win over V1 is precision of what is packed, not more files found.`),
          h('li', {}, 'Learning is not shown to help: the gain is small and its interval includes zero, on simulated outcomes only.'),
          h('li', {}, `Latency: V3 is about ${ms(lat)} slower at p95 than V2, because the graph lives in HydraDB and every request asks it for a neighbourhood.`),
          h('li', {}, 'One repository (a Vue admin template). The benchmark is public so others can add theirs.'),
        ),
      ),
    ),
  );
};

export function legend(variants: string[]): HTMLElement {
  const names: Record<string, string> = { oracle: 'oracle (ceiling)', random: 'random', V1: 'V1 vector chunks', V2: 'V2 no graph', V3: 'V3 graph (HydraDB)', V3r: 'V3r local replica', V5: 'V5 + learning' };
  return h('div', { class: 'legend' }, variants.map((v) => h('span', { class: `v-${v}` }, names[v] ?? v)));
}
