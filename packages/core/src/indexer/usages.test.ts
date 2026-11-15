import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { fileId, symId } from '../util/ids.js';
import { discover } from './discover.js';
import { profileRepo } from './profile.js';
import { makeResolver, type Resolver } from './resolve.js';
import { extractTsImports } from './ts-imports.js';
import { parseTs } from './ts-parse.js';
import { extractTsSymbols } from './ts-symbols.js';
import { extractUsages, kindForName, templateValueRefs } from './usages.js';
import { parseVueSfc } from './vue-sfc.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');
const read = (rel: string) => readFileSync(join(FIXTURE, rel), 'utf8');

let resolve: Resolver;
beforeAll(async () => {
  resolve = makeResolver(profileRepo(FIXTURE), new Set((await discover(FIXTURE)).allPaths));
});

const ofTs = (path: string, src = read(path)) => {
  const sf = parseTs(src, path);
  return extractUsages(sf, { path, resolve, imports: extractTsImports(sf), symbols: extractTsSymbols(sf), ownerDefault: fileId(path) });
};
const refSummary = (r: { refs: { from: string; kind: string; targetPath: string; targetName: string }[] }) =>
  r.refs.map((x) => `${x.from} -${x.kind}-> ${x.targetPath}#${x.targetName}`);

describe('extractUsages (PROMPTS 049)', () => {
  it('composable → store and → another composable', () => {
    const p = 'src/composables/useCartTotals.ts';
    expect(refSummary(ofTs(p))).toEqual([
      `${symId(p, 'useCartTotals')} -uses_store-> src/stores/cart.ts#useCartStore`,
      `${symId(p, 'useCartTotals')} -uses_composable-> src/composables/useFormat.ts#useFormat`,
    ]);
  });

  it('store → util function; type-only imports produce nothing', () => {
    const p = 'src/stores/order.ts';
    expect(refSummary(ofTs(p))).toEqual([`${symId(p, 'useOrderStore')} -calls-> src/utils/money.ts#sumMinor`]);
  });

  it('top-level code belongs to the file node; value references count, not just calls', () => {
    const p = 'src/router/index.ts';
    const r = ofTs(p);
    expect(refSummary(r)).toEqual([`${symId(p, 'routes')} -calls-> src/views/HomeView.vue#default`]);
    // `createRouter({ routes })` → same-file edge router → routes
    expect(r.edges.map((e) => `${e.from} -${e.kind}-> ${e.to}`)).toEqual([`${symId(p, 'router')} -calls-> ${symId(p, 'routes')}`]);
  });

  it('main.ts: statements outside any symbol are owned by the file', () => {
    const p = 'src/main.ts';
    expect(refSummary(ofTs(p))).toEqual([
      `${fileId(p)} -calls-> src/App.vue#default`,
      `${fileId(p)} -calls-> src/router/index.ts#router`, // app.use(router) comes before app.component(…)
      `${fileId(p)} -calls-> src/components/index.ts#BaseButton`,
    ]);
  });

  it('SFC script setup: the component owns top-level code', () => {
    const p = 'src/components/CheckoutButton.vue';
    const sfc = parseVueSfc(read(p), p);
    const script = sfc.scripts[0]!;
    const comp = symId(p, 'CheckoutButton');
    const r = extractUsages(script.sf, { path: p, resolve, imports: sfc.imports, symbols: sfc.symbols, ownerDefault: comp });
    expect(refSummary(r)).toEqual([
      `${comp} -uses_store-> src/stores/order.ts#useOrderStore`,
      `${comp} -uses_composable-> src/composables/useSubmit.ts#useSubmit`,
    ]);
  });

  it('same-file edges between top-level symbols, by target kind; no self edges', () => {
    const p = 'src/x.ts';
    const r = ofTs(p, `function a() { b(); a(); }
function b() {}
export const c = () => a()
export const useThing = () => ({})
export function caller() { useThing(); return c }`);
    expect(r.edges.map((e) => `${e.from.split('#')[1]} -${e.kind}-> ${e.to.split('#')[1]}`)).toEqual([
      'a -calls-> b', 'c -calls-> a', 'caller -uses_composable-> useThing', 'caller -calls-> c',
    ]);
  });

  it('namespace imports target the accessed member', () => {
    const p = 'src/x.ts';
    const r = ofTs(p, "import * as money from '@/utils/money';\nexport function total() { return money.sumMinor([1]) }\n");
    expect(refSummary(r)).toEqual([`${symId(p, 'total')} -calls-> src/utils/money.ts#sumMinor`]);
  });

  it('ignores type positions, property names, declarations and external packages', () => {
    const p = 'src/x.ts';
    const r = ofTs(p, `import { computed } from 'vue';
import { sumMinor, formatPrice } from '@/utils/money';
import type { Order } from '@/types/order';
export function f(o: Order, sumMinor2: typeof formatPrice) { const x = { sumMinor: 1 }; return o.sumMinor ?? computed(() => x) }`);
    expect(refSummary(r)).toEqual([]);
  });

  it('kindForName', () => {
    expect([kindForName('useUserStore'), kindForName('useFetch'), kindForName('formatPrice'), kindForName('user')]).toEqual(['uses_store', 'uses_composable', 'calls', 'calls']);
  });
});

describe('templateValueRefs', () => {
  it('imports used only in the template are references from the component; tags and .vue imports are not', () => {
    const p = 'src/views/Price.vue';
    const src = `<script setup lang="ts">
import { formatPrice } from '@/utils/money'
import BaseButton from '@/components/BaseButton.vue'
import { useFormat } from '@/composables/useFormat'
</script>
<template><BaseButton :label="formatPrice(100)" /></template>`;
    const sfc = parseVueSfc(src, p);
    const refs = templateValueRefs(sfc.template!.source, sfc.imports, resolve, p, symId(p, 'Price'));
    expect(refs.map((r) => `${r.kind}:${r.targetPath}#${r.targetName}`)).toEqual(['calls:src/utils/money.ts#formatPrice']);
  });
});
