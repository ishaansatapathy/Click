import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildIndex } from '../indexer/build.js';
import type { GraphNode } from '../types.js';
import { buildLexicalIndex, tokenize } from './lexical.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');

const n = (id: string, name: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id, kind: 'function', path: `src/${name}.ts`, name, tokens: 1, sigTokens: 0, fileHash: 'h', ...extra,
});

describe('tokenize (PROMPTS 085)', () => {
  it('splits camel, Pascal, kebab, snake and digit boundaries', () => {
    expect(tokenize('useOrderStore')).toEqual(['use', 'order', 'store']);
    expect(tokenize('CheckoutButton.vue')).toEqual(['checkout', 'button', 'vue']);
    expect(tokenize('order-summary_item2')).toEqual(['order', 'summary', 'item']); // "2" is a 1-char token
    expect(tokenize('HTMLParser')).toEqual(['html', 'parser']);
    expect(tokenize('v2Api')).toEqual(['api']);
  });
  it('lowercases, drops 1-char tokens, strips a trailing plural s on long tokens only', () => {
    expect(tokenize('Orders a I')).toEqual(['order']);
    expect(tokenize('class bus gas')).toEqual(['class', 'bus', 'gas']); // ss kept; ≤3 chars kept as is
    expect(tokenize('items')).toEqual(['item']);
  });
  it('handles unicode and punctuation, and empty text', () => {
    expect(tokenize('café-münchen')).toEqual(['café', 'münchen']);
    expect(tokenize('  ,,; ')).toEqual([]);
    expect(tokenize('')).toEqual([]);
  });
});

describe('buildLexicalIndex (PROMPTS 085)', () => {
  it('ranks by field-weighted match: a name hit beats a doc-only hit', () => {
    const idx = buildLexicalIndex({
      nodes: [n('a', 'helper', { doc: 'computes the order total' }), n('b', 'orderTotal'), n('c', 'unrelated')],
    });
    const res = idx.search('order total', 5);
    expect(res.map((r) => r.id)).toEqual(['b', 'a']);
    expect(res[0]!.score).toBeGreaterThan(res[1]!.score);
  });

  it('rare terms outweigh common ones (idf)', () => {
    const nodes = [n('a', 'storeA'), n('b', 'storeB'), n('c', 'storeC'), n('d', 'storeRefund')];
    const res = buildLexicalIndex({ nodes }).search('store refund', 4);
    expect(res[0]!.id).toBe('d');
  });

  it('is deterministic: equal scores order by id; k limits; empty and unknown queries give nothing', () => {
    const idx = buildLexicalIndex({ nodes: [n('z', 'order'), n('m', 'order'), n('a', 'order')] });
    expect(idx.search('order', 10).map((r) => r.id)).toEqual(['a', 'm', 'z']);
    expect(idx.search('order', 2)).toHaveLength(2);
    expect(idx.search('', 5)).toEqual([]);
    expect(idx.search('zzzunknown', 5)).toEqual([]);
    expect(idx.search('order', 0)).toEqual([]);
  });

  it('skips chunk nodes and handles an empty graph', () => {
    const idx = buildLexicalIndex({ nodes: [n('c1', 'orderChunk', { kind: 'chunk' }), n('f', 'orderFn')] });
    expect(idx.docCount).toBe(1);
    expect(idx.search('order', 5).map((r) => r.id)).toEqual(['f']);
    expect(buildLexicalIndex({ nodes: [] }).search('order', 5)).toEqual([]);
  });

  it('plural and singular match each other, signature terms count', () => {
    const idx = buildLexicalIndex({ nodes: [n('a', 'x1', { signature: 'function submitOrders(items: Item[])' }), n('b', 'other')] });
    expect(idx.search('submit order', 3).map((r) => r.id)).toEqual(['a']);
  });

  it('on the fixture, "order store submitting" ranks useOrderStore first', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'click-lex-'));
    const { graph } = await buildIndex(FIXTURE, undefined, { cacheDir, now: () => new Date('2026-11-15T10:00:00.000Z') });
    rmSync(cacheDir, { recursive: true, force: true });
    const idx = buildLexicalIndex(graph);
    const top = idx.search('order store submitting', 3);
    const first = graph.nodes.find((x) => x.id === top[0]!.id)!;
    expect(first.name).toBe('useOrderStore');
  });
});
