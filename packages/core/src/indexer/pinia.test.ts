import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractPiniaStores } from './pinia.js';
import { parseTs } from './ts-parse.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');
const read = (rel: string) => readFileSync(join(FIXTURE, rel), 'utf8').replace(/\r\n/g, '\n');
const stores = (src: string) => extractPiniaStores(parseTs(src));
const lineOf = (text: string, needle: string) => text.slice(0, text.indexOf(needle)).split('\n').length;

describe('extractPiniaStores on the fixture (PROMPTS 047)', () => {
  it('setup style: refs → state, computed → getters, functions → actions', () => {
    const src = read('src/stores/order.ts');
    expect(stores(src)).toEqual([
      {
        name: 'useOrderStore', id: 'order', style: 'setup',
        state: ['current', 'isSubmitting'], getters: ['total'], actions: ['submitOrder', 'load'],
        // the store is the last statement: it ends on the file's final `});`
        range: { startLine: lineOf(src, 'export const useOrderStore'), endLine: src.trimEnd().split('\n').length },
      },
    ]);
  });

  it('options style with an id field', () => {
    expect(stores(read('src/stores/cart.ts'))).toMatchObject([
      { name: 'useCartStore', id: 'cart', style: 'options', state: ['items'], getters: ['count'], actions: ['addItem', 'removeItem'] },
    ]);
  });
});

describe('extractPiniaStores variants', () => {
  it("options style with the id as first argument, state() method form", () => {
    expect(stores(`export const useUi = defineStore('ui', {
  state() { return { open: false, theme: 'dark' } },
  getters: { isDark: (s) => s.theme === 'dark' },
  actions: { toggle() { this.open = !this.open } },
})`)).toMatchObject([{ id: 'ui', style: 'options', state: ['open', 'theme'], getters: ['isDark'], actions: ['toggle'] }]);
  });

  it('setup style: reactive, composables, arrows, renamed and destructured returns', () => {
    const [s] = stores(`export const useApp = defineStore('app', () => {
  const sidebar = reactive({ opened: true })
  const device = useStorage('device', 'desktop')
  const width = computed(() => 1)
  const toggle = () => {}
  function close() {}
  const { token } = storeToRefs(useUserStore())
  return { sidebar, device, width, toggle, close, token, shut: close, isWide: computed(() => true), log() {} }
})`);
    expect(s).toMatchObject({
      id: 'app', style: 'setup',
      state: ['sidebar', 'device', 'token'],
      getters: ['width', 'isWide'],
      actions: ['toggle', 'close', 'shut', 'log'],
    });
  });

  it('arrow returning an object directly', () => {
    expect(stores(`export const useMini = defineStore('mini', () => ({ count: ref(0), inc: () => {} }))`)).toMatchObject([
      { state: ['count'], actions: ['inc'] },
    ]);
  });

  it('several stores in one file; other consts are ignored', () => {
    const s = stores(`export const a = 1;\nexport const useA = defineStore('a', () => ({}));\nexport const useB = defineStore('b', {});\n`);
    expect(s.map((x) => [x.name, x.id, x.style])).toEqual([['useA', 'a', 'setup'], ['useB', 'b', 'options']]);
  });

  it('flags setup stores whose members are built at runtime (as in v3-admin-vite settings store)', () => {
    const [s] = stores(`export const useSettings = defineStore('settings', () => {
  const state = {} as Record<string, unknown>
  for (const [k, v] of Object.entries(config)) state[k] = ref(v)
  return state
})`);
    expect(s).toMatchObject({ id: 'settings', style: 'setup', state: [], getters: [], actions: [], dynamic: true });
    expect(stores(`export const useA = defineStore('a', () => ({}))`)[0]?.dynamic).toBeUndefined();
  });

  it('applies lineOffset', () => {
    expect(extractPiniaStores(parseTs(`export const useA = defineStore('a', () => ({}))`), { lineOffset: 7 })[0]?.range).toEqual({ startLine: 8, endLine: 8 });
  });
});
