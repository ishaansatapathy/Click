import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractVueMeta, type ComponentMeta } from './vue-meta.js';
import { parseVueSfc } from './vue-sfc.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');
const fixtureMeta = (rel: string): ComponentMeta => extractVueMeta(parseVueSfc(readFileSync(join(FIXTURE, rel), 'utf8'), rel));
const meta = (script: string, template = '<div/>', attrs = 'setup lang="ts"'): ComponentMeta =>
  extractVueMeta(parseVueSfc(`<script ${attrs}>\n${script}\n</script>\n<template>${template}</template>\n`, 'X.vue'));

describe('extractVueMeta on the fixture components (PROMPTS 045)', () => {
  it('BaseButton: withDefaults(defineProps<{…}>()), typed defineEmits, default slot from the template', () => {
    expect(fixtureMeta('src/components/BaseButton.vue')).toEqual({
      api: 'setup', props: ['label', 'disabled', 'loading'], emits: ['click'], slots: ['default'], exposed: [], models: [],
    });
  });

  it('CheckoutButton: runtime defineEmits array', () => {
    expect(fixtureMeta('src/components/CheckoutButton.vue')).toMatchObject({ api: 'setup', props: [], emits: ['submitted'] });
  });

  it('OrderSummary: props, defineSlots and the named <slot> agree on "footer"', () => {
    expect(fixtureMeta('src/components/OrderSummary.vue')).toMatchObject({ props: ['order'], slots: ['footer'] });
  });

  it('CartItem: Options API object inside defineComponent, plus $emit in the template', () => {
    expect(fixtureMeta('src/components/CartItem.vue')).toEqual({
      api: 'options', name: 'CartItem', props: ['item'], emits: ['remove'], slots: [], exposed: [], models: [],
    });
  });

  it('OrdersView: template-only component has no API surface', () => {
    expect(fixtureMeta('src/views/OrdersView.vue')).toEqual({ api: 'none', props: [], emits: [], slots: [], exposed: [], models: [] });
  });
});

describe('extractVueMeta macro forms', () => {
  it('defineProps<Props>() with a local interface (including extends) and type alias', () => {
    const m = meta(`interface Base { id: string }
interface Props extends Base { title: string; count?: number }
type Extra = { flag: boolean }
defineProps<Props & Extra>()`);
    expect(m.props).toEqual(['title', 'count', 'id', 'flag']);
    expect(m.propsType).toBeUndefined();
  });

  it('records imported prop types it cannot expand', () => {
    const m = meta(`import type { TableProps } from './types'\ndefineProps<TableProps>()`);
    expect(m.props).toEqual([]);
    expect(m.propsType).toBe('TableProps');
  });

  it('runtime defineProps: array and object forms', () => {
    expect(meta(`defineProps(['a', 'b'])`).props).toEqual(['a', 'b']);
    expect(meta(`const p = defineProps({ size: String, color: { type: String, default: 'red' } })`).props).toEqual(['size', 'color']);
  });

  it('defineEmits: union call signatures, 3.3 named tuples, runtime object', () => {
    expect(meta(`defineEmits<{ (e: 'open' | 'close'): void; (e: 'select', id: number): void }>()`).emits).toEqual(['open', 'close', 'select']);
    expect(meta(`defineEmits<{ change: [id: number]; 'update:value': [v: string] }>()`).emits).toEqual(['change', 'update:value']);
    expect(meta(`defineEmits({ submit: (p: unknown) => true, cancel: null })`).emits).toEqual(['submit', 'cancel']);
  });

  it('defineModel adds a prop, an update emit and a model', () => {
    const m = meta(`const title = defineModel<string>('title')\nconst v = defineModel()`);
    expect(m.models).toEqual(['title', 'modelValue']);
    expect(m.props).toEqual(['title', 'modelValue']);
    expect(m.emits).toEqual(['update:title', 'update:modelValue']);
  });

  it('defineExpose and defineOptions', () => {
    const m = meta(`function open() {}\ndefineExpose({ open, close: () => {}, reset() {} })\ndefineOptions({ name: 'FancyDialog' })`);
    expect(m.exposed).toEqual(['open', 'close', 'reset']);
    expect(m.name).toBe('FancyDialog');
  });

  it('template slots: named, default and dynamic, deduplicated', () => {
    expect(meta('', '<div><slot/><slot name="header"/><slot :name="x"/><slot name="header"/></div>').slots).toEqual(['default', 'header', '[dynamic]']);
  });

  it('plain object Options API without defineComponent', () => {
    const m = meta(`export default { name: 'Plain', props: ['a'], emits: { done: null }, expose: ['focus'] }`, '<div/>', 'lang="ts"');
    expect(m).toMatchObject({ api: 'options', name: 'Plain', props: ['a'], emits: ['done'], exposed: ['focus'] });
  });
});
