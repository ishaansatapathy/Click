import type { Page } from '../app.js';
import { DataError, type DemoRepo } from '../data/types.js';
import { clear, h } from '../dom.js';
import type { Answer } from '../engine.js';

const SAMPLE_TASKS = [
  'When a user logs out, clear every piece of session state, remove open and cached tabs, reset access-controlled navigation, and then return them to the sign-in screen.',
  'After user details load, build the accessible route tree from roles and permissions and register it with the router.',
  'Make the sidebar collapse automatically on narrow screens and keep the device type in sync on resize.',
  'Rename the theme composable and update everything that uses it.',
];

const BUDGETS = [2000, 4000, 8000];

async function loadDemo(): Promise<DemoRepo> {
  const res = await fetch(`${import.meta.env.BASE_URL}data/demo.json`);
  if (!res.ok) throw new DataError('demo.json', `HTTP ${res.status}`);
  return (await res.json()) as DemoRepo;
}

function resultCard(title: string, sub: string, a: Answer, other: Answer): HTMLElement {
  const otherFiles = new Set(other.items.filter((i) => i.mode === 'body' || i.mode === 'file').map((i) => i.path));
  const bodies = a.items.filter((i) => i.mode === 'body' || i.mode === 'file');
  const files = new Set(bodies.map((i) => i.path));
  const extra = [...files].filter((p) => !otherFiles.has(p));
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'q' }, sub),
    h('h3', {}, title),
    h('p', { class: 'small muted' }, `${a.tokens.toLocaleString()} of ${a.budget.toLocaleString()} tokens · ${bodies.length} code blocks from ${files.size} files · ${a.ms < 1 ? 'under 1' : a.ms} ms in your browser`),
    extra.length && a.mode === 'graph' ? h('p', { class: 'small' }, h('b', {}, `${extra.length} file${extra.length > 1 ? 's' : ''} only the graph found: `), extra.map((p) => String(p).replace(/^src\//, '')).join(', ')) : null,
    h(
      'ul',
      { class: 'files' },
      a.items.slice(0, 16).map((i) => {
        const w = a.why.get(i.nodeId);
        const via = w?.via.length ? ` via ${w.via.map((k) => k.split('|')[1]).join(' → ')}` : '';
        return h('li', { title: w?.reasons.join('; ') ?? '' }, h('span', {}, h('code', { class: 'small' }, i.name), ' ', h('span', { class: 'muted small' }, String(i.path ?? '').replace(/^src\//, ''))), h('span', {}, h('span', { class: 'tag' }, i.mode), h('span', { class: 'muted small' }, `${i.tokens} tok${via}`)));
      }),
    ),
    a.items.length > 16 ? h('p', { class: 'small muted' }, `+ ${a.items.length - 16} more`) : null,
    h(
      'details',
      {},
      h('summary', { class: 'small' }, 'The text an agent would receive'),
      h('p', { class: 'small muted' }, 'The sample repository is written by a Chinese-speaking team. In this demo copy the text of its Chinese comments is blanked (line numbers are unchanged); string literals are untouched.'),
      h('pre', { class: 'ctx' }, a.text),
    ),
  );
}

export const tryIt: Page = ({ data }) => {
  const out = h('div', { class: 'cols' });
  const status = h('p', { class: 'small muted' }, 'Loading the sample repository…');
  const box = h('textarea', { id: 'task', 'aria-label': 'Describe a coding task', placeholder: 'Describe a change you would ask an agent to make…' }, SAMPLE_TASKS[0]);
  const budget = h('select', { 'aria-label': 'Token budget' }, BUDGETS.map((b) => h('option', { value: b, ...(b === 4000 ? { selected: true } : {}) }, `${b.toLocaleString()} tokens`)));
  const go = h('button', { class: 'primary', type: 'button', disabled: true }, 'Get context');

  const heldOut = data.examples.map((e) => e.text).filter((t) => t && !SAMPLE_TASKS.includes(t)).slice(0, 3);

  let engine: import('../engine.js').Engine | null = null;
  const run = async (): Promise<void> => {
    if (!engine) return;
    const text = (box as HTMLTextAreaElement).value.trim();
    if (!text) return;
    const b = Number((budget as HTMLSelectElement).value);
    go.setAttribute('disabled', '');
    try {
      const [graph, plain] = [await engine.ask(text, b, 'graph'), await engine.ask(text, b, 'plain')];
      clear(out);
      out.append(resultCard('With Click (graph walk)', 'Seeds → personalised PageRank over the code graph', graph, plain), resultCard('Same seeds, no graph', 'What a search-only retriever would pack', plain, graph));
      status.textContent = `Seeds: ${graph.seeds.slice(0, 6).map((s) => s.name).join(', ') || 'none found'}`;
    } finally {
      go.removeAttribute('disabled');
    }
  };
  go.addEventListener('click', () => void run());
  box.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter' && ((ev as KeyboardEvent).metaKey || (ev as KeyboardEvent).ctrlKey)) void run();
  });

  void (async () => {
    try {
      const [repo, { Engine }] = await Promise.all([loadDemo(), import('../engine.js')]);
      engine = new Engine(repo);
      status.textContent = `Ready: ${repo.name} indexed (${Object.keys(repo.files).length} files, ${repo.graph.nodes.length} nodes, ${repo.graph.edges.length} edges). Press Get context.`;
      go.removeAttribute('disabled');
      await run();
    } catch (e) {
      status.textContent = `The demo could not start: ${e instanceof Error ? e.message : String(e)}`;
    }
  })();

  return h(
    'div',
    {},
    h('h1', {}, 'Try it'),
    h('p', { class: 'lead muted' }, `Ask for a change in the sample project (${data.results.repo.name}, a Vue 3 admin template). Click's retrieval code runs here in your browser and shows what it would hand an agent, next to what the same search finds without the graph.`),
    h('div', { class: 'callout info' }, h('b', {}, 'What runs here, and what does not. '), 'Real: symbol and keyword search, rank fusion, the personalised-PageRank walk, candidate selection and token-budgeted packing, all the same modules the daemon uses. Not here: query embeddings (they need an API key) and HydraDB itself (the daemon fetches the graph neighbourhood from it; this page holds the same graph in memory). So the browser result is close to, not identical to, what the benchmark measures. The sample project is v3-admin-vite by pany, used under its MIT licence.'),
    h('div', { class: 'card' }, box, h('div', { class: 'chips' }, [...SAMPLE_TASKS, ...heldOut].map((t) => h('button', { class: 'chip', type: 'button', onclick: () => { (box as HTMLTextAreaElement).value = t; void run(); } }, t.length > 58 ? `${t.slice(0, 56)}…` : t))), h('div', { class: 'row' }, budget, go, status)),
    h('div', { style: 'height:16px' }),
    out,
  );
};
