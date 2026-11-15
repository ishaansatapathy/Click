import { describe, expect, it } from 'vitest';
import type { EdgeKind } from '../types.js';
import { buildCsr, type Csr, type CsrEdge } from './csr.js';
import { pprPush, rankScores, type PprOptions } from './ppr.js';
import { applyWeights } from './weights.js';

const OPTS: PprOptions = { alpha: 0.15, epsilon: 1e-9, maxPushes: 1_000_000 };
const KINDS: EdgeKind[] = ['calls', 'uses_store', 'imports', 'uses_component', 'contains', 'has_type'];

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `n${String(i).padStart(2, '0')}`);
const edge = (from: string, kind: EdgeKind, to: string): CsrEdge => ({ key: `${from}|${kind}|${to}`, from, to, kind });
const weighted = (nodeIds: string[], edges: CsrEdge[], useLearned = false, doc?: Parameters<typeof applyWeights>[2]): Csr =>
  applyWeights(buildCsr(nodeIds, edges), { usePriors: true, reverseScale: 1, useLearned }, doc);

/** Reference: personalised PageRank by iterating the walk, with dangling nodes keeping all their mass. */
function powerIteration(csr: Csr, restart: Map<number, number>, alpha: number, rounds = 400): Float64Array {
  let x = new Float64Array(csr.n);
  for (const [i, m] of restart) x[i] = m;
  const p = new Float64Array(csr.n);
  for (let t = 0; t < rounds; t++) {
    const next = new Float64Array(csr.n);
    for (let u = 0; u < csr.n; u++) {
      const xu = x[u]!;
      if (xu === 0) continue;
      if (csr.wsum[u] === 0) {
        p[u]! += xu;
        continue;
      }
      p[u]! += alpha * xu;
      for (let a = csr.offsets[u]!; a < csr.offsets[u + 1]!; a++) next[csr.targets[a]!]! += ((1 - alpha) * xu * csr.w[a]!) / csr.wsum[u]!;
    }
    x = next;
  }
  return p;
}

function randomGraph(n: number, m: number, seed: number): { nodeIds: string[]; edges: CsrEdge[] } {
  const rnd = mulberry32(seed);
  const nodeIds = ids(n);
  const edges: CsrEdge[] = [];
  while (edges.length < m) {
    const a = Math.floor(rnd() * (n - 2)); // the last two nodes stay isolated
    const b = Math.floor(rnd() * (n - 2));
    if (a === b) continue;
    edges.push(edge(nodeIds[a]!, KINDS[Math.floor(rnd() * KINDS.length)]!, nodeIds[b]!));
  }
  return { nodeIds, edges };
}

describe('pprPush (PROMPTS 088)', () => {
  it('matches power iteration on a 30-node graph (L1 error < 1e-3)', () => {
    const { nodeIds, edges } = randomGraph(30, 60, 7);
    const csr = weighted(nodeIds, edges);
    const seeds = [{ nodeId: 'n03', score: 0.6 }, { nodeId: 'n17', score: 0.4 }];
    const res = pprPush(csr, seeds, OPTS);
    const ref = powerIteration(csr, new Map([[3, 0.6], [17, 0.4]]), OPTS.alpha);
    let l1 = 0;
    for (let i = 0; i < csr.n; i++) l1 += Math.abs((res.scores.get(i) ?? 0) - ref[i]!);
    expect(l1).toBeLessThan(1e-3);
    expect(res.stats.truncated).toBe(false);
  });

  it('with the default epsilon it is still within 1e-3 of power iteration', () => {
    const { nodeIds, edges } = randomGraph(30, 60, 11);
    const csr = weighted(nodeIds, edges);
    const res = pprPush(csr, [{ nodeId: 'n00', score: 1 }], { alpha: 0.15, epsilon: 1e-6, maxPushes: 200_000 });
    const ref = powerIteration(csr, new Map([[0, 1]]), 0.15);
    let l1 = 0;
    for (let i = 0; i < csr.n; i++) l1 += Math.abs((res.scores.get(i) ?? 0) - ref[i]!);
    expect(l1).toBeLessThan(1e-3);
  });

  it('is deterministic and independent of seed input order', () => {
    const { nodeIds, edges } = randomGraph(30, 60, 3);
    const csr = weighted(nodeIds, edges);
    const a = pprPush(csr, [{ nodeId: 'n01', score: 2 }, { nodeId: 'n05', score: 1 }], OPTS);
    const b = pprPush(csr, [{ nodeId: 'n05', score: 1 }, { nodeId: 'n01', score: 2 }], OPTS);
    expect([...a.scores]).toEqual([...b.scores]);
    expect([...a.via]).toEqual([...b.via]);
    expect(a.stats).toEqual(b.stats);
  });

  it('respects maxPushes and says it was truncated', () => {
    const { nodeIds, edges } = randomGraph(30, 60, 5);
    const csr = weighted(nodeIds, edges);
    const res = pprPush(csr, [{ nodeId: 'n02', score: 1 }], { ...OPTS, maxPushes: 5 });
    expect(res.stats.pushes).toBe(5);
    expect(res.stats.truncated).toBe(true);
    const total = [...res.scores.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(1);
  });

  it('dangling nodes keep their mass: an isolated seed scores 1', () => {
    const csr = weighted(ids(5), [edge('n00', 'calls', 'n01')]);
    const res = pprPush(csr, [{ nodeId: 'n04', score: 1 }], OPTS);
    expect(res.scores.get(4)).toBeCloseTo(1, 9);
    expect(res.scores.size).toBe(1);
  });

  it('arcs weighing 0 (learned edges while learning is off) carry no mass, and make the node dangling', () => {
    const learned = edge('n00', 'co_changed', 'n01');
    const doc = { v: 1 as const, version: 'w', derivedFrom: null, events: 1, params: { alpha: 0.2, beta: 0.1, min: 0.1, max: 5 }, multipliers: {}, addedEdges: [{ ...learned, meta: { source: 'learned' as const } }] };
    const off = pprPush(weighted(ids(3), [learned], false, doc), [{ nodeId: 'n00', score: 1 }], OPTS);
    expect(off.scores.get(0)).toBeCloseTo(1, 9);
    expect(off.scores.has(1)).toBe(false);
    const on = pprPush(weighted(ids(3), [learned], true, doc), [{ nodeId: 'n00', score: 1 }], OPTS);
    expect(on.scores.get(1)!).toBeGreaterThan(0.3);
  });

  it('mass follows heavier edges, and a learned multiplier shifts it', () => {
    // a --uses_store--> b ; a --imports--> c : uses_store (1.2) beats imports (0.6)
    const edges = [edge('a', 'uses_store', 'b'), edge('a', 'imports', 'c')];
    const base = pprPush(weighted(['a', 'b', 'c'], edges), [{ nodeId: 'a', score: 1 }], OPTS);
    expect(base.scores.get(1)!).toBeGreaterThan(base.scores.get(2)! * 1.5);
    const doc = { v: 1 as const, version: 'w', derivedFrom: null, events: 1, params: { alpha: 0.2, beta: 0.1, min: 0.1, max: 5 }, multipliers: { 'a|imports|c': 5 }, addedEdges: [] };
    const boosted = pprPush(weighted(['a', 'b', 'c'], edges, true, doc), [{ nodeId: 'a', score: 1 }], OPTS);
    expect(boosted.scores.get(2)!).toBeGreaterThan(boosted.scores.get(1)!);
  });

  it('records, for each reached node, the arc that delivered the most mass', () => {
    const csr = weighted(['a', 'b', 'c'], [edge('a', 'calls', 'b'), edge('b', 'calls', 'c')]);
    const res = pprPush(csr, [{ nodeId: 'a', score: 1 }], OPTS);
    const vb = res.via.get(csr.index.get('b')!)!;
    expect(vb.from).toBe(csr.index.get('a'));
    expect(csr.edges[csr.edgeIdx[vb.arc]!]!.key).toBe('a|calls|b');
    const vc = res.via.get(csr.index.get('c')!)!;
    expect(vc.from).toBe(csr.index.get('b'));
    expect([...res.seedIdx]).toEqual([csr.index.get('a')]);
  });

  it('ignores seeds that are not in the graph and renormalises over the rest', () => {
    const csr = weighted(['a', 'b'], [edge('a', 'calls', 'b')]);
    const res = pprPush(csr, [{ nodeId: 'a', score: 0.1 }, { nodeId: 'ghost', score: 0.9 }, { nodeId: 'b', score: 0 }], OPTS);
    expect(res.stats.missingSeeds).toBe(2);
    expect([...res.scores.values()].reduce((x, y) => x + y, 0)).toBeCloseTo(1, 6);
    expect(pprPush(csr, [], OPTS).scores.size).toBe(0);
  });

  it('rankScores orders best first with ties by id', () => {
    const csr = weighted(['a', 'b', 'c'], [edge('a', 'contains', 'b'), edge('a', 'contains', 'c')]);
    const res = pprPush(csr, [{ nodeId: 'a', score: 1 }], OPTS);
    const ranked = rankScores(csr, res);
    expect(ranked[0]!.id).toBe('a');
    expect(ranked.slice(1).map((r) => r.id)).toEqual(['b', 'c']);
    expect(rankScores(csr, res, 1)).toHaveLength(1);
  });

  it('is fast on a larger graph (20k nodes, 100k edges, one seed)', () => {
    const { nodeIds, edges } = randomGraph(20_000, 100_000, 99);
    const csr = weighted(nodeIds, edges);
    const t0 = performance.now();
    const res = pprPush(csr, [{ nodeId: nodeIds[10]!, score: 1 }], { alpha: 0.15, epsilon: 1e-6, maxPushes: 200_000 });
    expect(performance.now() - t0).toBeLessThan(1_500); // a safety net: the suite runs next to many others (typically ~30 ms alone)
    expect(res.stats.pushes).toBeGreaterThan(0);
  });
});
