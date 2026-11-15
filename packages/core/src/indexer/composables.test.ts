import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractComposables } from './composables.js';
import { parseTs } from './ts-parse.js';
import { extractTsSymbols } from './ts-symbols.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');
const composablesOf = (src: string) => {
  const sf = parseTs(src);
  return extractComposables(sf, extractTsSymbols(sf));
};
const fixture = (rel: string) => composablesOf(readFileSync(join(FIXTURE, rel), 'utf8'));

describe('extractComposables (PROMPTS 048)', () => {
  it('fixture: function declarations and exported arrows, with returned keys', () => {
    expect(fixture('src/composables/useSubmit.ts').map((c) => [c.name, c.returns])).toEqual([['useSubmit', ['isSubmitting', 'run']]]);
    expect(fixture('src/composables/useFormat.ts').map((c) => [c.name, c.returns])).toEqual([['useFormat', ['price']]]);
    expect(fixture('src/composables/useCartTotals.ts').map((c) => [c.name, c.returns])).toEqual([['useCartTotals', ['subtotal', 'label']]]);
  });

  it('stores are not composables, even though their names start with "use"', () => {
    expect(fixture('src/stores/order.ts')).toEqual([]);
    expect(fixture('src/stores/cart.ts')).toEqual([]);
  });

  it('keeps helpers that return a store (useXStoreOutside), skips non-exported and non-use functions', () => {
    const cs = composablesOf(`export function useUserStoreOutside() { return useUserStore(pinia) }
function useLocalOnly() { return { a: 1 } }
export function formatDate() {}
export const user = 1
export const useFetch = () => ({ data, loading, refresh })`);
    expect(cs.map((c) => [c.name, c.returns])).toEqual([['useUserStoreOutside', []], ['useFetch', ['data', 'loading', 'refresh']]]);
  });

  it('carries the symbol range', () => {
    const [c] = composablesOf('\n\nexport function useX() {\n  return { a }\n}\n');
    expect(c?.range).toEqual({ startLine: 3, endLine: 5 });
  });
});
