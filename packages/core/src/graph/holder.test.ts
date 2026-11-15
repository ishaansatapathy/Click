import { describe, expect, it } from 'vitest';
import type { Graph, GraphEdge, GraphNode, WeightsDoc } from '../types.js';
import { GraphHolder } from './holder.js';
import type { WeightSettings } from './weights.js';

const DEFAULTS: WeightSettings = { usePriors: true, reverseScale: 1, useLearned: false };
const LEARNED: WeightSettings = { ...DEFAULTS, useLearned: true };

const node = (id: string): GraphNode => ({ id, kind: 'function', path: 'a.ts', name: id, tokens: 1, sigTokens: 0, fileHash: 'h' });
const edge = (from: string, kind: GraphEdge['kind'], to: string): GraphEdge => ({ key: `${from}|${kind}|${to}`, from, to, kind });
const graph = (version: string, ids: string[], edges: GraphEdge[]): Graph => ({ version, repoCommit: null, nodes: ids.map(node), edges, chunks: [] });
const doc = (version: string, multipliers: Record<string, number> = {}, addedEdges: GraphEdge[] = []): WeightsDoc => ({
  v: 1, version, derivedFrom: null, events: 1, params: { alpha: 0.2, beta: 0.1, min: 0.1, max: 5 }, multipliers, addedEdges,
});

const g1 = graph('g1', ['a', 'b', 'c'], [edge('a', 'uses_store', 'b'), edge('b', 'calls', 'c')]);
const g2 = graph('g2', ['a', 'b', 'c', 'd'], [edge('a', 'uses_store', 'b'), edge('b', 'calls', 'c'), edge('c', 'calls', 'd')]);

describe('GraphHolder (PROMPTS 083)', () => {
  it('serves the current state: graph, csr over its edges, lexical index, weights version', () => {
    const h = new GraphHolder(g1, { buildLexical: (g) => `lex:${g.version}` });
    const s = h.current();
    expect(s.graph).toBe(g1);
    expect(s.lexical).toBe('lex:g1');
    expect(s.csr.n).toBe(3);
    expect(s.csr.targets.length).toBe(4);
    expect(s.weights).toBeNull();
    expect(s.weightsVersion).toBeNull();
  });

  it('a request that took the state before a swap never sees the swap', () => {
    const h = new GraphHolder(g1, { buildLexical: (g) => g.version, weights: doc('w1', { 'a|uses_store|b': 2 }) });
    const inFlight = h.current();
    const wBefore = Array.from(h.weighted(LEARNED, inFlight).w);

    h.swapGraph(g2);
    h.swapWeights(doc('w2', { 'a|uses_store|b': 3 }));

    expect(inFlight.graph.version).toBe('g1');
    expect(inFlight.lexical).toBe('g1');
    expect(inFlight.csr.n).toBe(3);
    expect(inFlight.weightsVersion).toBe('w1');
    expect(Array.from(h.weighted(LEARNED, inFlight).w)).toEqual(wBefore); // same memoised arrays, untouched
    const now = h.current();
    expect(now.graph.version).toBe('g2');
    expect(now.weightsVersion).toBe('w2');
    expect(now).not.toBe(inFlight);
  });

  it('states are immutable', () => {
    const s = new GraphHolder(g1).current();
    expect(Object.isFrozen(s)).toBe(true);
    expect(() => {
      (s as { graph: Graph }).graph = g2;
    }).toThrow();
  });

  it('swapGraph rebuilds csr and lexical but keeps the weights doc', () => {
    const d = doc('w1', { 'a|uses_store|b': 2 });
    const h = new GraphHolder(g1, { buildLexical: (g) => g.version, weights: d });
    const s = h.swapGraph(g2);
    expect(s.csr.n).toBe(4);
    expect(s.lexical).toBe('g2');
    expect(s.weights).toBe(d);
  });

  it('swapWeights with the same learned-edge set shares the structure and the lexical index', () => {
    let lexBuilds = 0;
    const h = new GraphHolder(g1, { buildLexical: () => ++lexBuilds });
    const before = h.current();
    const after = h.swapWeights(doc('w1', { 'a|uses_store|b': 1.5 }));
    expect(after.csr).toBe(before.csr); // only multipliers changed: no structure rebuild
    expect(after.lexical).toBe(before.lexical);
    expect(lexBuilds).toBe(1);
    expect(after.weightsVersion).toBe('w1');
  });

  it('swapWeights with a different learned-edge set rebuilds the structure (and only the structure)', () => {
    let lexBuilds = 0;
    const h = new GraphHolder(g1, { buildLexical: () => ++lexBuilds });
    const before = h.current();
    const after = h.swapWeights(doc('w2', {}, [{ ...edge('a', 'co_changed', 'c'), meta: { source: 'learned' } }]));
    expect(after.csr).not.toBe(before.csr);
    expect(after.csr.targets.length).toBe(before.csr.targets.length + 2);
    expect(after.lexical).toBe(before.lexical);
    expect(lexBuilds).toBe(1);
    // and back to no weights: the learned edge disappears again
    expect(h.swapWeights(null).csr.targets.length).toBe(before.csr.targets.length);
  });

  it('weighted() is memoised per state and settings, and differs between settings', () => {
    const h = new GraphHolder(g1, { weights: doc('w1', { 'a|uses_store|b': 2 }) });
    const a = h.weighted(DEFAULTS);
    expect(h.weighted(DEFAULTS)).toBe(a);
    expect(h.weighted({ ...DEFAULTS })).toBe(a); // equal settings, same entry
    const l = h.weighted(LEARNED);
    expect(l).not.toBe(a);
    expect(l.w[l.offsets[l.index.get('a')!]!]).toBeCloseTo(1.2 * 2);
    expect(a.w[a.offsets[a.index.get('a')!]!]).toBeCloseTo(1.2);
    expect(l.offsets).toBe(a.offsets); // structure shared across settings
    // a new state does not reuse the old state's memo
    h.swapGraph(g2);
    expect(h.weighted(DEFAULTS)).not.toBe(a);
  });

  it('works with the default (no lexical index, no weights)', () => {
    const h = new GraphHolder(g1);
    expect(h.current().lexical).toBeNull();
    expect(h.weighted(DEFAULTS).wsum.length).toBe(3);
  });
});
