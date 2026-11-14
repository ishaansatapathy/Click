import { describe, expect, it } from 'vitest';
import type { ChunkRecord, GraphEdge, GraphNode, WeightsDoc } from '../types.js';
import { netCounter } from '../util/http.js';
import { FakeEmbedder, FakeStore, fakeTokens } from './fakes.js';

const node = (id: string, name: string, kind: GraphNode['kind'] = 'function'): GraphNode => ({
  id, kind, path: 'src/a.ts', name, tokens: 10, sigTokens: 3, fileHash: 'h',
});
const chunk = (id: string, text: string, vector?: number[]): ChunkRecord => ({
  id, nodeId: 'sym:src/a.ts#x', path: 'src/a.ts', range: { startLine: 1, endLine: 5 }, text, vector,
});
const edge = (from: string, to: string): GraphEdge => ({ key: `${from}|calls|${to}`, from, to, kind: 'calls' });

describe('fakeTokens', () => {
  it('splits identifiers', () => {
    expect(fakeTokens('useOrderStore')).toEqual(['use', 'order', 'store']);
    expect(fakeTokens('<checkout-button> HTTPClient')).toEqual(['checkout', 'button', 'http', 'client']);
  });
});

describe('FakeStore', () => {
  it('upserts idempotently and removes', async () => {
    const s = new FakeStore();
    await s.upsert({ nodes: [node('n1', 'a')], edges: [edge('n1', 'n2')], chunks: [chunk('c1', 'x')] }, 'v1');
    await s.upsert({ nodes: [node('n1', 'renamed')] }, 'v2');
    expect(s.nodes.size).toBe(1);
    expect(s.nodes.get('n1')?.name).toBe('renamed');
    await s.remove({ nodeIds: ['n1'], edgeKeys: ['n1|calls|n2'], chunkIds: ['c1'] });
    expect([s.nodes.size, s.edges.size, s.chunks.size]).toEqual([0, 0, 0]);
  });

  it('hybridQuery finds a chunk by its own text, best first, capped at k', async () => {
    const s = new FakeStore();
    await s.upsert(
      {
        chunks: [
          chunk('c-order', 'export const useOrderStore = defineStore("order", () => { submitOrder })'),
          chunk('c-cart', 'export function addToCart(item) {}'),
          chunk('c-other', 'unrelated text here'),
        ],
      },
      'v1',
    );
    const hits = await s.hybridQuery({ text: 'submit order store', k: 2 });
    expect(hits[0]?.id).toBe('c-order');
    expect(hits.length).toBeLessThanOrEqual(2);
    expect(hits.every((h) => h.id !== 'c-other')).toBe(true);
  });

  it('searches nodes when kinds are given', async () => {
    const s = new FakeStore();
    await s.upsert({ nodes: [node('s1', 'useOrderStore', 'store'), node('f1', 'useOrderStore', 'function')] }, 'v1');
    expect((await s.hybridQuery({ text: 'order store', k: 5, kinds: ['store'] })).map((h) => h.id)).toEqual(['s1']);
  });

  it('uses vectors when both sides have them', async () => {
    const s = new FakeStore();
    await s.upsert({ chunks: [chunk('c1', 'zzz', [1, 0]), chunk('c2', 'zzz', [0, 1])] }, 'v1');
    const hits = await s.hybridQuery({ text: 'nothing matches', vector: [0, 1], k: 5 });
    expect(hits.map((h) => h.id)).toEqual(['c2']);
  });

  it('counts each query as one network call', async () => {
    const s = new FakeStore();
    const { calls } = await netCounter.run(async () => {
      await s.hybridQuery({ text: 'a', k: 1 });
      await s.hybridQuery({ text: 'b', k: 1 });
    });
    expect(calls).toBe(2);
    expect(s.queries).toBe(2);
  });

  it('simulates latency and honours abort', async () => {
    const s = new FakeStore({ latencyMs: 2000 });
    const ctrl = new AbortController();
    const started = Date.now();
    const p = s.hybridQuery({ text: 'x', k: 1 }, ctrl.signal);
    setTimeout(() => ctrl.abort(new Error('deadline')), 20);
    await expect(p).rejects.toThrow('deadline');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('can be made to fail', async () => {
    const s = new FakeStore({ failWith: new Error('hydra down') });
    await expect(s.hybridQuery({ text: 'x', k: 1 })).rejects.toThrow('hydra down');
  });

  it('loadAll returns everything in pages', async () => {
    const s = new FakeStore({ pageSize: 2 });
    await s.upsert({ nodes: [node('a', 'a'), node('b', 'b'), node('c', 'c')], edges: [edge('a', 'b')], chunks: [chunk('k', 't')] }, 'v1');
    const pages = [];
    for await (const p of s.loadAll()) pages.push(p);
    expect(pages.flatMap((p) => p.nodes ?? []).map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
    expect(pages.flatMap((p) => p.edges ?? [])).toHaveLength(1);
    expect(pages.flatMap((p) => p.chunks ?? [])).toHaveLength(1);
    expect(pages.filter((p) => p.nodes).length).toBe(2);
  });

  it('round-trips weights and conventions without sharing references', async () => {
    const s = new FakeStore();
    expect(await s.getWeights()).toBeNull();
    const w: WeightsDoc = {
      v: 1, version: 'w1', derivedFrom: null, events: 0,
      params: { alpha: 0.2, beta: 0.1, min: 0.1, max: 5 }, multipliers: { k: 1.2 }, addedEdges: [],
    };
    await s.putWeights(w);
    w.multipliers.k = 99;
    expect((await s.getWeights())?.multipliers.k).toBe(1.2);
    await s.putConventions([{ id: 'conv:x', text: 't', source: 's', validFrom: '2026-11-15', validTo: null }]);
    expect(await s.getConventions()).toHaveLength(1);
  });
});

describe('FakeEmbedder', () => {
  const cos = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0);

  it('is deterministic, unit-length and has the configured dims', async () => {
    const e = new FakeEmbedder(32);
    const [a1] = await e.embed(['useOrderStore submit'], 'document');
    const [a2] = await e.embed(['useOrderStore submit'], 'query');
    expect(a1).toHaveLength(32);
    expect(Array.from(a1!)).toEqual(Array.from(a2!));
    expect(cos(a1!, a1!)).toBeCloseTo(1, 5);
  });

  it('puts texts with shared identifiers closer together', async () => {
    const e = new FakeEmbedder();
    const [q, near, far] = await e.embed(['order store submit', 'useOrderStore submitOrder', 'format date string'], 'query');
    expect(cos(q!, near!)).toBeGreaterThan(cos(q!, far!));
  });

  it('handles empty text and abort', async () => {
    const e = new FakeEmbedder();
    const [z] = await e.embed([''], 'document');
    expect(Array.from(z!).every((x) => x === 0)).toBe(true);
    const ctrl = new AbortController();
    ctrl.abort(new Error('stop'));
    await expect(e.embed(['x'], 'query', ctrl.signal)).rejects.toThrow('stop');
  });
});
