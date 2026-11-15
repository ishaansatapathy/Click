import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { discover } from './discover.js';
import { profileRepo } from './profile.js';
import { makeResolver, type Resolver } from './resolve.js';
import { extractTsImports } from './ts-imports.js';
import { parseTs } from './ts-parse.js';
import { camelize, extractTemplateUsages, findGlobalRegistrations, pascalTag, templateRefs, type GlobalComponents, type TemplateCtx } from './vue-template.js';
import { parseVueSfc } from './vue-sfc.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');
const read = (rel: string) => readFileSync(join(FIXTURE, rel), 'utf8').replace(/\r\n/g, '\n');
const lineOf = (text: string, needle: string) => text.slice(0, text.indexOf(needle)).split('\n').length;

let resolve: Resolver;
let globals: GlobalComponents;
let autoImport: Record<string, string>;
beforeAll(async () => {
  const files = new Set((await discover(FIXTURE)).allPaths);
  const profile = profileRepo(FIXTURE);
  resolve = makeResolver(profile, files);
  autoImport = profile.autoImport.components;
  const main = read('src/main.ts');
  const sf = parseTs(main, 'src/main.ts');
  globals = findGlobalRegistrations(sf, extractTsImports(sf), resolve, 'src/main.ts');
});
const ctxFor = (path: string, extra: Partial<TemplateCtx> = {}): TemplateCtx => ({ path, resolve, globals, autoImport, ...extra });
const usagesOf = (rel: string) => extractTemplateUsages(parseVueSfc(read(rel), rel), ctxFor(rel));

describe('global registrations', () => {
  it("app.component('BaseButton', BaseButton) from the barrel import", () => {
    expect(globals.get('BaseButton')).toEqual({ path: 'src/components/index.ts', exportName: 'BaseButton' });
  });
  it('skips dynamic registrations (loops over icon maps)', () => {
    const sf = parseTs("import * as Icons from 'icons';\nfor (const [k, c] of Object.entries(Icons)) app.component(k, c);\n");
    expect(findGlobalRegistrations(sf, extractTsImports(sf), resolve, 'src/x.ts').size).toBe(0);
  });
});

describe('extractTemplateUsages on the fixture (PROMPTS 046)', () => {
  it('CheckoutButton → BaseButton via the barrel import: props and listeners', () => {
    const src = read('src/components/CheckoutButton.vue');
    const [u, ...rest] = usagesOf('src/components/CheckoutButton.vue');
    expect(rest).toEqual([]);
    expect(u).toEqual({
      tag: 'BaseButton', name: 'BaseButton', line: lineOf(src, '<BaseButton'),
      props: ['label', 'loading', 'disabled'], events: ['click'],
      resolution: { kind: 'local', target: { path: 'src/components/index.ts', exportName: 'BaseButton' }, via: 'import' },
    });
  });

  it('HomeView → kebab-case <cart-item> resolved through the auto-import map; key is not a prop', () => {
    const [u] = usagesOf('src/views/HomeView.vue');
    expect(u).toMatchObject({
      name: 'CartItem', props: ['item'], events: ['remove'],
      resolution: { kind: 'local', target: { path: 'src/components/CartItem.vue', exportName: 'default' }, via: 'auto' },
    });
  });

  it('CheckoutView → auto-imported OrderSummary, imported CheckoutButton inside a slot template', () => {
    const us = usagesOf('src/views/CheckoutView.vue').filter((u) => u.resolution.kind === 'local');
    expect(us.map((u) => [u.name, u.props, u.events, u.resolution.kind === 'local' && u.resolution.via])).toEqual([
      ['OrderSummary', ['order'], [], 'auto'],
      ['CheckoutButton', [], ['submitted'], 'import'],
    ]);
  });

  it('a recursive component referring to itself by file name is "self", not unresolved, and makes no edge', () => {
    const src = '<template><li><Item v-for="c in children" :item="c" /></li></template>';
    const us = extractTemplateUsages(parseVueSfc(src, 'src/layouts/Sidebar/Item.vue'), ctxFor('src/layouts/Sidebar/Item.vue'));
    expect(us.map((u) => u.resolution)).toEqual([{ kind: 'self' }]);
    expect(templateRefs('sym:src/layouts/Sidebar/Item.vue#Item', us)).toEqual([]);
  });

  it('App → RouterLink/RouterView imported from vue-router are not local edges', () => {
    const kinds = usagesOf('src/App.vue').map((u) => [u.name, u.resolution.kind]);
    expect(kinds).toEqual([['RouterLink', 'builtin'], ['RouterLink', 'builtin'], ['RouterView', 'builtin']]);
  });

  it('globally registered components resolve without an import; libraries are external; unknowns are reported', () => {
    const src = '<template><base-button label="Hi" /><el-button type="primary" @click="go" /><MysteryWidget /><div/></template>';
    const us = extractTemplateUsages(parseVueSfc(src, 'src/views/X.vue'), ctxFor('src/views/X.vue', { autoImport: { ...autoImport, ElButton: 'element-plus/es' } }));
    expect(us.map((u) => [u.name, u.resolution])).toEqual([
      ['BaseButton', { kind: 'local', target: { path: 'src/components/index.ts', exportName: 'BaseButton' }, via: 'global' }],
      ['ElButton', { kind: 'external', pkg: 'element-plus' }],
      ['MysteryWidget', { kind: 'unresolved' }],
    ]);
  });

  it('v-model, v-model:arg, kebab props and update: listeners are normalised', () => {
    const src = `<script setup lang="ts">import Dialog from '@/components/OrderSummary.vue'</script>
<template><Dialog v-model="open" v-model:selected-id="id" :max-items="3" data-test="x" @update:model-value="log" @close-all="c" /></template>`;
    const [u] = extractTemplateUsages(parseVueSfc(src, 'src/views/Y.vue'), ctxFor('src/views/Y.vue'));
    expect(u?.props).toEqual(['modelValue', 'selectedId', 'maxItems', 'dataTest']);
    expect(u?.events).toEqual(['update:modelValue', 'update:selectedId', 'closeAll']);
  });
});

describe('templateRefs', () => {
  it('emits one uses_component per target, plus passes_prop and emits_to with the merged names', () => {
    const us = usagesOf('src/views/CheckoutView.vue');
    expect(templateRefs('sym:src/views/CheckoutView.vue#CheckoutView', us)).toEqual([
      { from: 'sym:src/views/CheckoutView.vue#CheckoutView', targetPath: 'src/components/OrderSummary.vue', targetName: 'default', kind: 'uses_component', meta: { source: 'ast' } },
      { from: 'sym:src/views/CheckoutView.vue#CheckoutView', targetPath: 'src/components/OrderSummary.vue', targetName: 'default', kind: 'passes_prop', meta: { source: 'ast', props: ['order'] } },
      { from: 'sym:src/views/CheckoutView.vue#CheckoutView', targetPath: 'src/components/CheckoutButton.vue', targetName: 'default', kind: 'uses_component', meta: { source: 'ast' } },
      { from: 'sym:src/views/CheckoutView.vue#CheckoutView', targetPath: 'src/components/CheckoutButton.vue', targetName: 'default', kind: 'emits_to', meta: { source: 'ast', events: ['submitted'] } },
    ]);
  });

  it('merges repeated usages of one component', () => {
    const src = `<script setup lang="ts">import C from '@/components/CartItem.vue'</script>
<template><C :item="a" @remove="r" /><C :item="b" :index="1" @select="s" /></template>`;
    const refs = templateRefs('sym:src/v.vue#V', extractTemplateUsages(parseVueSfc(src, 'src/v.vue'), ctxFor('src/v.vue')));
    expect(refs.filter((r) => r.kind === 'uses_component')).toHaveLength(1);
    expect(refs.find((r) => r.kind === 'passes_prop')?.meta?.props).toEqual(['item', 'index']);
    expect(refs.find((r) => r.kind === 'emits_to')?.meta?.events).toEqual(['remove', 'select']);
  });
});

describe('name helpers', () => {
  it('camelize and pascalTag', () => {
    expect(camelize('selected-id')).toBe('selectedId');
    expect(camelize('update:model-value')).toBe('update:modelValue');
    expect(pascalTag('el-table-column')).toBe('ElTableColumn');
    expect(pascalTag('SvgIcon')).toBe('SvgIcon');
  });
});
