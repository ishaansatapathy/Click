import './styles.css';
import { ROUTES, routeFor } from './app.js';
import { loadData, type DashboardData } from './data/types.js';
import { clear, h } from './dom.js';

const root = document.getElementById('app')!;

function theme(): 'light' | 'dark' {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function toggleTheme(): void {
  const next = theme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('click-theme', next);
  } catch {
    // storage can be blocked; the choice then lasts for this visit only
  }
}

function shell(): { nav: HTMLElement; view: HTMLElement } {
  const nav = h('nav', { 'aria-label': 'Sections' });
  const view = h('main', { id: 'view' });
  clear(root);
  root.append(
    h('header', { class: 'top' }, h('div', { class: 'bar-inner' }, h('a', { class: 'brand', href: '#/' }, h('i'), 'Click'), nav, h('button', { type: 'button', onclick: toggleTheme, 'aria-label': 'Toggle light and dark theme' }, '◐'))),
    view,
    h(
      'footer',
      {},
      'Click is open source (MIT). Every number on this site comes from a row of ',
      h('code', {}, 'bench/results.jsonl'),
      '; hover a bar or an interval for its run id. Graph storage: self-hosted HydraDB (open source, Docker). ',
      h('a', { href: 'https://github.com/ishaansatapathy/Click' }, 'github.com/ishaansatapathy/Click'),
    ),
  );
  return { nav, view };
}

async function start(): Promise<void> {
  const { nav, view } = shell();
  let data: DashboardData;
  try {
    data = await loadData();
  } catch (e) {
    view.append(h('div', { class: 'callout' }, h('b', {}, 'The data files did not load. '), e instanceof Error ? e.message : String(e)));
    return;
  }
  const render = async (): Promise<void> => {
    const route = routeFor(location.hash);
    clear(nav);
    for (const r of ROUTES) nav.append(h('a', { href: `#${r.path}`, ...(r.path === route.path ? { 'aria-current': 'page' } : {}) }, r.title));
    document.title = route.path === '/' ? 'Click: a context layer for coding agents' : `${route.title} · Click`;
    clear(view);
    try {
      const page = await route.load();
      view.append(await page({ data }));
    } catch (e) {
      view.append(h('div', { class: 'callout' }, h('b', {}, 'This page failed to render. '), e instanceof Error ? e.message : String(e)));
    }
    window.scrollTo(0, 0);
  };
  window.addEventListener('hashchange', () => void render());
  await render();
}

void start();
