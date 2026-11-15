import { describe, expect, it } from 'vitest';
import type { GraphNode, NodeKind } from '../types.js';
import { buildSymbolIndex, extractIdentifiers } from './symbols.js';

const texts = (s: string): string[] => extractIdentifiers(s).map((i) => i.text);

const node = (id: string, name: string, path: string | null, kind: NodeKind = 'function'): GraphNode => ({
  id, kind, path, name, tokens: 1, sigTokens: 0, fileHash: 'h',
});

describe('extractIdentifiers (PROMPTS 086)', () => {
  it('backticked code, including dotted calls', () => {
    expect(texts('fix `useOrderStore` and `store.submit()`')).toEqual(expect.arrayContaining(['useOrderStore', 'store.submit', 'store', 'submit']));
  });
  it('CamelCase, camelCase and useX in prose', () => {
    expect(texts('The CheckoutButton calls submitOrder via useCart now')).toEqual(expect.arrayContaining(['CheckoutButton', 'submitOrder', 'useCart']));
  });
  it('kebab tags map to the PascalCase component name too', () => {
    expect(texts('the <order-summary> tag is wrong')).toEqual(expect.arrayContaining(['order-summary', 'OrderSummary']));
  });
  it('file names and paths, quoted single words, snake_case', () => {
    const ids = extractIdentifiers('see src/stores/order.ts, checkout.vue and "routeName" plus order_id.');
    expect(ids.map((i) => i.text)).toEqual(expect.arrayContaining(['src/stores/order.ts', 'checkout.vue', 'routeName', 'order_id']));
    expect(ids.find((i) => i.text === 'checkout.vue')!.file).toBe(true);
    expect(ids.find((i) => i.text === 'routeName')!.file).toBe(false);
  });
  it('plain lowercase prose and quoted sentences are not identifiers', () => {
    expect(texts('make the order button disabled while submitting')).toEqual([]);
    expect(texts('error says "something went wrong here"')).toEqual([]);
    expect(texts('')).toEqual([]);
  });
  it('trailing punctuation is trimmed and duplicates collapse', () => {
    expect(texts('Look at CheckoutButton, then CheckoutButton.')).toEqual(['CheckoutButton']);
  });
});

describe('buildSymbolIndex.match (PROMPTS 086)', () => {
  const nodes = [
    node('file:src/stores/order.ts', 'order.ts', 'src/stores/order.ts', 'file'),
    node('store:order', 'useOrderStore', 'src/stores/order.ts', 'store'),
    node('file:src/components/CheckoutButton.vue', 'CheckoutButton.vue', 'src/components/CheckoutButton.vue', 'file'),
    node('comp:CheckoutButton', 'CheckoutButton', 'src/components/CheckoutButton.vue', 'component'),
    node('fn:submitOrder', 'submitOrder', 'src/api/order.ts'),
    node('fn:submitOrderLater', 'submitOrderLater', 'src/api/later.ts'),
    node('comp:OrderSummary', 'OrderSummary', 'src/components/OrderSummary.vue', 'component'),
    node('chunk:x', 'useOrderStore', 'src/stores/order.ts', 'chunk'),
  ];
  const idx = buildSymbolIndex({ nodes });
  const score = (text: string, id: string): number | undefined => idx.match(text, 20).find((r) => r.id === id)?.score;

  it('exact name 1.0, case-insensitive 0.7, prefix 0.5', () => {
    expect(score('`submitOrder`', 'fn:submitOrder')).toBe(1);
    expect(score('`SUBMITORDER`', 'fn:submitOrder')).toBe(0.7);
    expect(score('`submitOrder`', 'fn:submitOrderLater')).toBe(0.5);
  });
  it('ranks exact above prefix, and never returns chunk nodes', () => {
    const r = idx.match('`submitOrder`', 5);
    expect(r.map((x) => x.id)).toEqual(['fn:submitOrder', 'fn:submitOrderLater']);
    expect(idx.match('`useOrderStore`', 5).map((x) => x.id)).toEqual(['store:order']);
  });
  it('a file name matches the file node, a path must agree with the path, kebab tags find components', () => {
    expect(score('open CheckoutButton.vue', 'file:src/components/CheckoutButton.vue')).toBe(1);
    expect(score('in src/stores/order.ts', 'file:src/stores/order.ts')).toBe(1);
    expect(score('in src/api/order.ts', 'file:src/stores/order.ts')).toBeUndefined();
    expect(score('the <order-summary> tag', 'comp:OrderSummary')).toBe(1);
  });
  it('short identifiers do not prefix-match', () => {
    expect(idx.match('`sub`', 5)).toEqual([]);
  });
  it('takes the best score over several identifiers and honours k', () => {
    const r = idx.match('`submitOrder` and `SUBMITORDER`', 1);
    expect(r).toEqual([{ id: 'fn:submitOrder', score: 1 }]);
    expect(idx.match('nothing identifier-like here', 5)).toEqual([]);
    expect(idx.match('`submitOrder`', 0)).toEqual([]);
  });
});
