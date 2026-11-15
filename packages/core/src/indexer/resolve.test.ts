import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { discover } from './discover.js';
import { profileRepo } from './profile.js';
import { makeResolver, packageName, type Resolver } from './resolve.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');

describe('resolver on the fixture repo (real profile + real discovery)', () => {
  let r: Resolver;
  beforeAll(async () => {
    const files = new Set((await discover(FIXTURE)).allPaths);
    r = makeResolver(profileRepo(FIXTURE), files);
  });

  it.each([
    ['./useFormat', 'src/composables/useCartTotals.ts', 'src/composables/useFormat.ts'],
    ['../stores/cart', 'src/composables/useCartTotals.ts', 'src/stores/cart.ts'],
    ['./App.vue', 'src/main.ts', 'src/App.vue'],
    ['./router', 'src/main.ts', 'src/router/index.ts'],
    ['@/stores/order', 'src/views/CheckoutView.vue', 'src/stores/order.ts'],
    ['@/components', 'src/main.ts', 'src/components/index.ts'],
    ['@/components/CheckoutButton.vue', 'src/views/CheckoutView.vue', 'src/components/CheckoutButton.vue'],
    ['./BaseButton.vue', 'src/components/index.ts', 'src/components/BaseButton.vue'],
    ['@/views/OrdersView.vue', 'src/router/index.ts', 'src/views/OrdersView.vue'],
    ['@/types/order', 'src/stores/order.ts', 'src/types/order.ts'],
  ])('%s from %s → %s', (spec, from, path) => {
    expect(r(spec, from)).toEqual({ kind: 'local', path });
  });

  it('classifies packages as external', () => {
    expect(r('vue', 'src/main.ts')).toEqual({ kind: 'external', pkg: 'vue' });
    expect(r('pinia', 'src/main.ts')).toEqual({ kind: 'external', pkg: 'pinia' });
    expect(r('vue-router/auto-routes', 'src/main.ts')).toEqual({ kind: 'external', pkg: 'vue-router' });
    expect(r('@vue/test-utils', 'tests/checkout.spec.ts')).toEqual({ kind: 'external', pkg: '@vue/test-utils' });
    expect(r('node:url', 'vite.config.ts')).toEqual({ kind: 'external', pkg: 'node:url' });
  });

  it('strips query suffixes', () => {
    expect(r('./App.vue?raw', 'src/main.ts')).toEqual({ kind: 'local', path: 'src/App.vue' });
    expect(r('@/utils/money?url', 'src/main.ts')).toEqual({ kind: 'local', path: 'src/utils/money.ts' });
  });

  it('maps TS-ESM .js specifiers to .ts files', () => {
    expect(r('./useFormat.js', 'src/composables/useCartTotals.ts')).toEqual({ kind: 'local', path: 'src/composables/useFormat.ts' });
  });

  it('resolves Vite root-absolute imports', () => {
    expect(r('/src/main.ts', 'src/App.vue')).toEqual({ kind: 'local', path: 'src/main.ts' });
  });

  it('reports what it cannot resolve, keeping the original spec', () => {
    expect(r('@/nope', 'src/main.ts')).toEqual({ kind: 'unresolved', spec: '@/nope' });
    expect(r('./missing', 'src/main.ts')).toEqual({ kind: 'unresolved', spec: './missing' });
    expect(r('./missing?raw', 'src/main.ts')).toEqual({ kind: 'unresolved', spec: './missing?raw' });
    expect(r('../../../outside', 'src/main.ts')).toEqual({ kind: 'unresolved', spec: '../../../outside' });
  });

  it('never throws on odd input', () => {
    for (const spec of ['', '.', '..', '@', '//', '?', '?raw', '@scope', '~/x', '#imports']) {
      expect(() => r(spec, 'src/main.ts')).not.toThrow();
      expect(r(spec, 'src/main.ts').kind).not.toBe('local');
    }
  });
});

describe('resolver rules in isolation', () => {
  const files = new Set([
    'src/x.ts',
    'src/common/x.ts',
    'src/lib/a.ts',
    'src/config/index.ts',
    'generated/api.ts',
    'src/utils/money.ts',
    'src/common/assets/styles/mixins.scss',
    'src/views/images/404.svg',
  ]);

  it('resolves asset imports (styles, images with ?component / ?url) when given all repo paths', () => {
    const r = makeResolver({ tsconfigPaths: {}, baseUrl: null, viteAliases: { '@': 'src', '@@': 'src/common' } }, files);
    expect(r('@@/assets/styles/mixins.scss', 'src/App.vue')).toEqual({ kind: 'local', path: 'src/common/assets/styles/mixins.scss' });
    expect(r('./images/404.svg?component', 'src/views/Err.vue')).toEqual({ kind: 'local', path: 'src/views/images/404.svg' });
  });

  it('Vite aliases: the longest key wins, "@@" before "@"', () => {
    const r = makeResolver({ tsconfigPaths: {}, baseUrl: null, viteAliases: { '@': 'src', '@@': 'src/common' } }, files);
    expect(r('@@/x', 'a.ts')).toEqual({ kind: 'local', path: 'src/common/x.ts' });
    expect(r('@/x', 'a.ts')).toEqual({ kind: 'local', path: 'src/x.ts' });
    expect(r('@x', 'a.ts').kind).toBe('unresolved'); // not an alias, not a valid package
  });

  it('tsconfig paths: exact key wins, then the longest prefix, then fallback targets in order', () => {
    const r = makeResolver(
      {
        tsconfigPaths: { config: ['src/config'], '@/*': ['src/*', 'generated/*'], '@/lib/*': ['src/lib/*'] },
        baseUrl: null,
        viteAliases: {},
      },
      files,
    );
    expect(r('config', 'a.ts')).toEqual({ kind: 'local', path: 'src/config/index.ts' });
    expect(r('@/lib/a', 'a.ts')).toEqual({ kind: 'local', path: 'src/lib/a.ts' });
    expect(r('@/api', 'a.ts')).toEqual({ kind: 'local', path: 'generated/api.ts' }); // first target missing
    expect(r('@/missing', 'a.ts')).toEqual({ kind: 'unresolved', spec: '@/missing' }); // matched a path pattern: local intent
  });

  it('baseUrl resolves non-relative specs before treating them as packages', () => {
    const r = makeResolver({ tsconfigPaths: {}, baseUrl: 'src', viteAliases: {} }, files);
    expect(r('utils/money', 'a.ts')).toEqual({ kind: 'local', path: 'src/utils/money.ts' });
    expect(r('lodash', 'a.ts')).toEqual({ kind: 'external', pkg: 'lodash' });
  });

  it('caches bare specs without leaking a query suffix between calls', () => {
    const r = makeResolver({ tsconfigPaths: {}, baseUrl: null, viteAliases: { '@': 'src' } }, files);
    expect(r('@/nope?raw', 'a.ts')).toEqual({ kind: 'unresolved', spec: '@/nope?raw' });
    expect(r('@/nope', 'b.ts')).toEqual({ kind: 'unresolved', spec: '@/nope' });
  });
});

describe('packageName', () => {
  it.each([
    ['vue', 'vue'],
    ['vue/dist/vue.esm', 'vue'],
    ['@vueuse/core', '@vueuse/core'],
    ['@vueuse/core/sub', '@vueuse/core'],
    ['node:fs', 'node:fs'],
    ['virtual:pwa-register', 'virtual:pwa-register'],
    ['~virtual/svg-component', '~virtual/svg-component'],
    ['@/x', null],
    ['~/x', null],
    ['#imports', null],
  ])('%s → %s', (spec, pkg) => {
    expect(packageName(spec)).toBe(pkg);
  });
});
