import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lineCount, parseVueSfc } from './vue-sfc.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');
const read = (rel: string) => readFileSync(join(FIXTURE, rel), 'utf8').replace(/\r\n/g, '\n');
/** 1-based line of the first occurrence of `needle`: the ground truth every range is checked against. */
const lineOf = (text: string, needle: string) => text.slice(0, text.indexOf(needle)).split('\n').length;

describe('parseVueSfc (SPEC §5.4)', () => {
  it('CheckoutView: symbols, imports and template carry real file line numbers', () => {
    const src = read('src/views/CheckoutView.vue');
    const r = parseVueSfc(src, 'src/views/CheckoutView.vue');
    expect(r.errors).toEqual([]);
    expect(r.componentName).toBe('CheckoutView');
    expect(r.range).toEqual({ startLine: 1, endLine: lineCount(src) });
    expect(r.scripts).toHaveLength(1);
    expect(r.scripts[0]).toMatchObject({ setup: true, lang: 'ts' });

    const fn = r.symbols.find((s) => s.name === 'onSubmitted');
    expect(fn?.range.startLine).toBe(lineOf(src, 'function onSubmitted'));
    expect(fn?.range.endLine).toBe(lineOf(src, 'function onSubmitted') + 2);

    expect(r.imports.map((i) => [i.spec, i.line])).toEqual([
      ['vue-router', lineOf(src, "from 'vue-router'")],
      ['@/components/CheckoutButton.vue', lineOf(src, "from '@/components/CheckoutButton.vue'")],
      ['@/stores/order', lineOf(src, "from '@/stores/order'")],
    ]);
    expect(r.template?.range.startLine).toBe(lineOf(src, '<template>'));
    expect(r.template?.ast.children.length).toBeGreaterThan(0);
  });

  it('Options API component: plain <script>, symbols from export default', () => {
    const src = read('src/components/CartItem.vue');
    const r = parseVueSfc(src, 'src/components/CartItem.vue');
    expect(r.scripts.map((s) => s.setup)).toEqual([false]);
    expect(r.symbols.find((s) => s.name === 'default')).toMatchObject({ callee: 'defineComponent', range: { startLine: lineOf(src, 'export default') } });
  });

  it('template-only component: no scripts, still a component covering the file', () => {
    const r = parseVueSfc(read('src/views/OrdersView.vue'), 'src/views/OrdersView.vue');
    expect(r.scripts).toEqual([]);
    expect(r.symbols).toEqual([]);
    expect(r.template).not.toBeNull();
  });

  it('merges <script> and <script setup>, each with its own offset', () => {
    const src = [
      '<script lang="ts">',
      "import { helper } from './helper';",
      'export function shared() { return helper(); }',
      '</script>',
      '',
      '<script setup lang="ts">',
      "import { ref } from 'vue';",
      'const count = ref(0);',
      'function increment() { count.value++; }',
      '</script>',
      '',
      '<template><button @click="increment">{{ count }}</button></template>',
      '<style scoped>button { color: red }</style>',
    ].join('\n');
    const r = parseVueSfc(src, 'src/components/counter-button.vue');
    expect(r.componentName).toBe('CounterButton');
    expect(r.scripts.map((s) => [s.setup, s.lineOffset])).toEqual([[false, 0], [true, 5]]);
    expect(r.symbols.map((s) => [s.name, s.range.startLine])).toEqual([['shared', 3], ['increment', 9]]);
    expect(r.imports.map((i) => [i.spec, i.line])).toEqual([['./helper', 2], ['vue', 7]]);
    expect(r.styleBlocks).toBe(1);
    expect(r.range).toEqual({ startLine: 1, endLine: 13 });
  });

  it('JS script blocks and missing lang default to js', () => {
    const r = parseVueSfc('<script>\nexport default { name: "A" }\n</script>\n', 'A.vue');
    expect(r.scripts[0]?.lang).toBe('js');
  });

  it('reports malformed SFCs as errors instead of throwing', () => {
    expect(() => parseVueSfc('<template><div></template>', 'Broken.vue')).not.toThrow();
    expect(parseVueSfc('<template><div></template>', 'Broken.vue').errors.length).toBeGreaterThan(0);
    expect(() => parseVueSfc('', 'Empty.vue')).not.toThrow();
  });
});
