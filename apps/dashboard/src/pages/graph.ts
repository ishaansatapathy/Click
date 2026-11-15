import { clear, h } from '../dom.js';
import { dependents, forceLayout, testsFor } from '../layout.js';
import type { Page } from '../app.js';

const W = 1000;
const H = 640;
const SVG = 'http://www.w3.org/2000/svg';
const sv = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

const classOf = (path: string): string => (/\/stores\//.test(path) ? 'store' : /router/.test(path) ? 'route' : path.endsWith('.vue') ? 'vue' : '');

export const graphPage: Page = ({ data }) => {
  const g = data.graph;
  if (!g) return h('div', { class: 'callout' }, 'graph.json is not part of this build.');
  const pos = forceLayout(g.nodes.map((n) => n.id), g.edges, { width: W, height: H });
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const hubIds = new Set(g.hubs.slice(0, 10).map((x) => x.id));

  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Code graph of ${data.results.repo.name}: ${g.nodes.length} files and ${g.edges.length} dependencies` });
  const edgeEls = g.edges.map((e) => {
    const a = pos.get(e.from)!;
    const b = pos.get(e.to)!;
    const el = sv('line', { class: 'edge', x1: a.x.toFixed(1), y1: a.y.toFixed(1), x2: b.x.toFixed(1), y2: b.y.toFixed(1) });
    svg.appendChild(el);
    return { e, el };
  });
  const nodeEls = new Map<string, SVGGElement>();
  for (const n of g.nodes) {
    const p = pos.get(n.id)!;
    const deg = g.hubs.find((x) => x.id === n.id)?.degree ?? 3;
    const gEl = sv('g', { class: `node ${classOf(n.path ?? '')}`, transform: `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`, tabindex: 0, role: 'button', 'aria-label': n.path ?? n.name });
    const c = sv('circle', { r: Math.min(14, 4 + Math.sqrt(deg)) });
    const title = sv('title');
    title.textContent = n.path ?? n.name;
    gEl.append(c, title);
    if (hubIds.has(n.id)) {
      const t = sv('text', { x: 9, y: 3 });
      t.textContent = n.name;
      gEl.appendChild(t);
    }
    gEl.addEventListener('click', () => select(n.id));
    gEl.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter' || (ev as KeyboardEvent).key === ' ') select(n.id);
    });
    svg.appendChild(gEl);
    nodeEls.set(n.id, gEl);
  }

  const panel = h('div', { class: 'card' });
  const select = (id: string): void => {
    const deps = dependents(g, id, 3);
    const depIds = new Map(deps.map((d) => [d.id, d]));
    for (const [nid, el] of nodeEls) el.setAttribute('class', `node ${classOf(byId.get(nid)?.path ?? '')}${nid === id ? ' sel' : depIds.has(nid) ? ' dep' : ''}`);
    for (const { e, el } of edgeEls) el.setAttribute('class', `edge${(depIds.has(e.from) || e.from === id) && (depIds.has(e.to) || e.to === id) ? ' hot' : ''}`);
    const tests = testsFor(g, id);
    clear(panel);
    panel.append(
      h('div', { class: 'q' }, 'If you change'),
      h('h3', {}, h('code', {}, byId.get(id)?.path ?? id)),
      deps.length
        ? h('p', {}, `${deps.length} file${deps.length === 1 ? '' : 's'} depend on it within three hops. Nearest first:`)
        : h('p', { class: 'muted' }, 'Nothing depends on this file, so changing it cannot break another file.'),
      h(
        'ul',
        { class: 'files stack' },
        deps.slice(0, 30).map((d) => h('li', {}, h('code', { class: 'small' }, byId.get(d.id)?.path ?? d.id), h('span', { class: 'muted small' }, `${d.hops} hop${d.hops > 1 ? 's' : ''} · ${[...d.chain].reverse().join(' ← ')}`))),
      ),
      deps.length > 30 ? h('p', { class: 'small muted' }, `+ ${deps.length - 30} more`) : '',
      tests.length ? h('p', { class: 'small' }, 'Covered by: ', tests.map((t) => byId.get(t)?.path ?? t).join(', ')) : h('p', { class: 'small muted' }, 'No test is linked to this file in the graph.'),
    );
  };

  const options = [...g.hubs.map((x) => x.id), ...g.nodes.map((n) => n.id).filter((id) => !hubIds.has(id) && !g.hubs.some((x) => x.id === id))];
  const picker = h(
    'select',
    { 'aria-label': 'Pick a file', onchange: (ev: Event) => select((ev.target as HTMLSelectElement).value) },
    h('option', { value: '' }, 'Pick a file, or click a dot…'),
    [...new Set(options)].map((id) => h('option', { value: id }, byId.get(id)?.path ?? id)),
  );

  const first = g.hubs.find((x) => /stores\/user/.test(x.id)) ?? g.hubs[0];
  if (first) select(first.id);

  return h(
    'div',
    {},
    h('h1', {}, 'Graph explorer'),
    h('p', { class: 'lead muted' }, `${data.results.repo.name}: ${g.nodes.length} files, ${g.edges.length} file-to-file edges (functions and components are folded into their file here to keep it readable; the real graph has ${data.results.repo.nodes} nodes and ${data.results.repo.edges} edges). Click a file to see what breaks if you change it, the same walk the daemon runs for /impact.`),
    h('div', { class: 'row', style: 'margin-bottom:12px' }, h('div', { style: 'flex:1;min-width:240px' }, picker), h('span', { class: 'small muted' }, 'green = Vue component · amber = store · blue = router · red = would be affected')),
    h('div', { class: 'cols', style: 'grid-template-columns:minmax(0,2fr) minmax(280px,1fr)' }, h('div', { class: 'graph-box' }, svg), panel),
    h('p', { class: 'small muted' }, 'The layout is computed in your browser from graph.json, which is exported from the same index Click stores in HydraDB. Hubs (most connected files) are labelled.'),
  );
};
