import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { discover } from './discover.js';
import { profileRepo } from './profile.js';
import { makeResolver, type Resolver } from './resolve.js';
import { extractRoutes, finalizeRoutes, joinRoutePath, type ConstLookup } from './router.js';
import { extractTsImports } from './ts-imports.js';
import { parseTs } from './ts-parse.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');

let resolve: Resolver;
beforeAll(async () => {
  resolve = makeResolver(profileRepo(FIXTURE), new Set((await discover(FIXTURE)).allPaths));
});

const noLookup: ConstLookup = () => undefined;
function routesOf(src: string, path = 'src/router/index.ts', lookup: ConstLookup = noLookup) {
  const sf = parseTs(src, path);
  const defs = extractRoutes(sf, { path, imports: extractTsImports(sf), resolve });
  return { defs, ...finalizeRoutes(defs, path, 'hash', lookup) };
}
const summary = (r: ReturnType<typeof routesOf>) =>
  r.nodes.map((n) => {
    const ref = r.refs.find((x) => x.from === n.id);
    return `${n.id} [${n.name}] → ${ref ? `${ref.targetPath}#${ref.targetName}` : '-'}`;
  });

describe('routes on the fixture (PROMPTS 050)', () => {
  it('static and lazy components, nested children with joined paths, names', () => {
    const r = routesOf(readFileSync(join(FIXTURE, 'src/router/index.ts'), 'utf8'));
    expect(summary(r)).toEqual([
      'route:/ [home] → src/views/HomeView.vue#default',
      'route:/orders [orders] → src/views/OrdersView.vue#default',
      'route:/orders/:id [order-detail] → src/views/OrderDetailView.vue#default',
      'route:/checkout [checkout] → src/views/CheckoutView.vue#default',
    ]);
    expect(r.refs.every((x) => x.kind === 'routes_to')).toBe(true);
    expect(r.nodes[2]).toMatchObject({ kind: 'route', path: 'src/router/index.ts', meta: { fullPath: '/orders/:id', lazy: true, routeName: 'order-detail' } });
    expect(r.nodes[2]?.signature).toBe('route /orders/:id (order-detail) → src/views/OrderDetailView.vue');
    expect(r.unresolvedPaths).toEqual([]);
  });
});

describe('route patterns from v3-admin-vite', () => {
  const SRC = `import { createRouter } from 'vue-router'
import { REDIRECT_PATH } from '@/utils/money'
import HomeView from '@/views/HomeView.vue'
const Layouts = () => import('@/views/OrdersView.vue')
const LOGIN = '/login'
export const constantRoutes: RouteRecordRaw[] = [
  { path: REDIRECT_PATH, component: Layouts, children: [{ path: ':path(.*)', component: () => import('@/views/CheckoutView.vue') }] },
  { path: LOGIN, component: defineAsyncComponent(() => import('@/views/OrderDetailView.vue')) },
  { path: '/', component: Layouts, redirect: '/dashboard', children: [{ path: 'dashboard', component: HomeView, name: 'Dashboard' }, { path: '', component: HomeView }] },
  { path: '/abs', component: Layouts, children: [{ path: '/elsewhere', component: () => {} }] },
  ...extraRoutes,
]
export const router = createRouter({ routes: [{ path: '/inline', component: HomeView }] })
`;

  it('resolves imported path consts through the lookup, local consts, lazy consts, async components', () => {
    const lookup: ConstLookup = (p, n) => (p === 'src/utils/money.ts' && n === 'REDIRECT_PATH' ? '/redirect' : undefined);
    expect(summary(routesOf(SRC, 'src/router/index.ts', lookup))).toEqual([
      'route:/redirect [/redirect] → src/views/OrdersView.vue#default',
      'route:/redirect/:path(.*) [/redirect/:path(.*)] → src/views/CheckoutView.vue#default',
      'route:/login [/login] → src/views/OrderDetailView.vue#default',
      'route:/ [/] → src/views/OrdersView.vue#default',
      'route:/dashboard [Dashboard] → src/views/HomeView.vue#default',
      'route:/abs [/abs] → src/views/OrdersView.vue#default',
      'route:/elsewhere [/elsewhere] → -',
      'route:/inline [/inline] → src/views/HomeView.vue#default',
    ]);
  });

  it('keeps an unresolvable path visible instead of dropping the route', () => {
    const r = routesOf(SRC);
    expect(r.unresolvedPaths).toEqual(['REDIRECT_PATH']);
    expect(r.nodes[0]?.id).toBe('route:/{REDIRECT_PATH}'); // placeholder joined like any top-level path
  });

  it("an empty child path is the parent route itself (deduplicated)", () => {
    const ids = routesOf(SRC).nodes.map((n) => n.id);
    expect(ids.filter((i) => i === 'route:/')).toHaveLength(1);
  });

  it('records redirects', () => {
    const r = routesOf(SRC);
    expect(r.nodes.find((n) => n.id === 'route:/')?.meta).toMatchObject({ redirect: '/dashboard' });
  });

  it('ignores arrays that are not route tables', () => {
    expect(routesOf(`export const items = [{ name: 'a' }, { name: 'b' }]\nexport const paths = ['/a', '/b']`).nodes).toEqual([]);
  });
});

describe('joinRoutePath', () => {
  it.each([
    ['', '/', '/'],
    ['', 'x', '/x'],
    ['/orders', ':id', '/orders/:id'],
    ['/orders/', ':id', '/orders/:id'],
    ['/orders', '/abs', '/abs'],
    ['/orders', '', '/orders'],
  ])('%s + %s → %s', (parent, child, full) => expect(joinRoutePath(parent, child)).toBe(full));
});
