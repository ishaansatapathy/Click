import type { DashboardData } from './data/types.js';

export interface PageContext {
  data: DashboardData;
}
/** A page builds its DOM from the loaded data. */
export type Page = (ctx: PageContext) => HTMLElement | Promise<HTMLElement>;

export interface Route {
  path: string;
  title: string;
  load: () => Promise<Page>;
}

export const ROUTES: Route[] = [
  { path: '/', title: 'Overview', load: async () => (await import('./pages/overview.js')).overview },
  { path: '/benchmark', title: 'Benchmark', load: async () => (await import('./pages/benchmark.js')).benchmark },
  { path: '/learning', title: 'Learning', load: async () => (await import('./pages/learning.js')).learning },
  { path: '/graph', title: 'Graph', load: async () => (await import('./pages/graph.js')).graphPage },
  { path: '/examples', title: 'Examples', load: async () => (await import('./pages/examples.js')).examples },
  { path: '/try', title: 'Try it', load: async () => (await import('./pages/try.js')).tryIt },
  { path: '/how', title: 'How it works', load: async () => (await import('./pages/how.js')).how },
  { path: '/gtm', title: 'Go to market', load: async () => (await import('./pages/gtm.js')).gtm },
];

/** '#/benchmark?x=1' -> '/benchmark'; anything unknown falls back to the overview. */
export function routeFor(hash: string): Route {
  const path = hash.replace(/^#/, '').split('?')[0] || '/';
  return ROUTES.find((r) => r.path === path) ?? ROUTES[0]!;
}
