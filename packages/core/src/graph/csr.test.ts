import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildIndex } from '../indexer/build.js';
import type { EdgeKind } from '../types.js';
import { EDGE_KINDS, buildCsr, csrFromEdges, csrFromGraph, type Csr, type CsrEdge } from './csr.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mini-vue');

const edge = (from: string, kind: EdgeKind, to: string): CsrEdge => ({ key: `${from}|${kind}|${to}`, from, to, kind });
/** Arcs of one node as readable strings. */
function arcs(csr: Csr, id: string): string[] {
  const u = csr.index.get(id)!;
  const out: string[] = [];
  for (let a = csr.offsets[u]!; a < csr.offsets[u + 1]!; a++) out.push(`${csr.dir[a] === 0 ? '→' : '←'}${EDGE_KINDS[csr.kind[a]!]}:${csr.ids[csr.targets[a]!]}`);
  return out;
}

describe('buildCsr (PROMPTS 081 / SPEC §6.1)', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const edges = [edge('a', 'imports', 'b'), edge('a', 'calls', 'c'), edge('c', 'uses_store', 'b')];

  it('stores both directions of every edge, with direction, kind and the edge to recover it', () => {
    const csr = buildCsr(ids, edges);
    expect(csr.n).toBe(4);
    expect(csr.targets.length).toBe(6);
    expect(arcs(csr, 'a')).toEqual(['→imports:b', '→calls:c']); // edges are ordered by (from, kind, to)
    expect(arcs(csr, 'b')).toEqual(['←imports:a', '←uses_store:c']);
    expect(arcs(csr, 'c')).toEqual(['←calls:a', '→uses_store:b']);
    expect(arcs(csr, 'd')).toEqual([]);
    for (let a = 0; a < csr.targets.length; a++) {
      const e = csr.edges[csr.edgeIdx[a]!]!;
      expect(EDGE_KINDS[csr.kind[a]!]).toBe(e.kind);
    }
  });

  it('has valid offsets (monotone, ending at 2E) and in-range targets', () => {
    const csr = buildCsr(ids, edges);
    expect(Array.from(csr.offsets)).toEqual([0, 2, 4, 6, 6]);
    for (let i = 0; i < csr.n; i++) expect(csr.offsets[i + 1]!).toBeGreaterThanOrEqual(csr.offsets[i]!);
    for (const t of csr.targets) expect(t >= 0 && t < csr.n).toBe(true);
    expect(csr.w.length).toBe(6);
    expect(csr.wsum.length).toBe(4);
    expect(Array.from(csr.w).every((x) => x === 0)).toBe(true); // weights are filled by weights.ts
  });

  it('depends only on the set of edges: any input order, with duplicates, gives identical arrays', () => {
    const a = buildCsr(ids, edges);
    const b = buildCsr(ids, [...edges].reverse().concat(edges[0]!, edges[1]!));
    for (const k of ['offsets', 'targets', 'edgeIdx', 'dir', 'kind'] as const) expect(Array.from(b[k]), k).toEqual(Array.from(a[k]));
    expect(b.edges).toEqual(a.edges);
    expect(b.skipped).toBe(0);
  });

  it('ignores edges with an unknown endpoint, self-loops and unknown kinds, and counts them', () => {
    const csr = buildCsr(ids, [...edges, edge('a', 'calls', 'ghost'), edge('x', 'calls', 'a'), edge('b', 'calls', 'b'), { key: 'a|nope|b', from: 'a', to: 'b', kind: 'nope' as EdgeKind }]);
    expect(csr.targets.length).toBe(6);
    expect(csr.skipped).toBe(4);
  });

  it('matches a naive sort-and-dedupe on random edge sets (duplicates, co_changed both ways, unknown nodes)', () => {
    let s = 7;
    const rnd = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const nodes = Array.from({ length: 40 }, (_, i) => `n${String(i).padStart(2, '0')}`);
    for (let round = 0; round < 30; round++) {
      const es: CsrEdge[] = Array.from({ length: 400 }, () => edge(nodes[Math.floor(rnd() * 42)] ?? 'ghost', EDGE_KINDS[Math.floor(rnd() * EDGE_KINDS.length)]!, nodes[Math.floor(rnd() * 42)] ?? 'ghost'));
      const csr = buildCsr(nodes, es);
      const idx = new Map(nodes.map((n, i) => [n, i]));
      const want = new Map<string, [number, number, number]>();
      for (const e of es) {
        let a = idx.get(e.from);
        let b = idx.get(e.to);
        if (a === undefined || b === undefined || a === b) continue;
        if (e.kind === 'co_changed' && a > b) [a, b] = [b, a];
        want.set(`${a}|${EDGE_KINDS.indexOf(e.kind)}|${b}`, [a, EDGE_KINDS.indexOf(e.kind), b]);
      }
      const expected = [...want.values()].sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
      const got = csr.edges.map((e) => {
        let a = idx.get(e.from)!;
        let b = idx.get(e.to)!;
        if (e.kind === 'co_changed' && a > b) [a, b] = [b, a];
        return [a, EDGE_KINDS.indexOf(e.kind), b];
      });
      expect(got, `round ${round}`).toEqual(expected);
      expect(csr.targets.length).toBe(2 * expected.length);
    }
  });

  it('handles empty graphs and nodes without edges', () => {
    expect(buildCsr([], []).n).toBe(0);
    const lone = buildCsr(['x', 'y'], []);
    expect(Array.from(lone.offsets)).toEqual([0, 0, 0]);
  });

  it('parallel edges of different kinds between the same nodes both exist', () => {
    const csr = buildCsr(['a', 'b'], [edge('a', 'imports', 'b'), edge('a', 'calls', 'b')]);
    expect(arcs(csr, 'a')).toEqual(['→imports:b', '→calls:b']);
  });

  it('a symmetric co_changed edge given in both directions is one edge', () => {
    const csr = buildCsr(['f1', 'f2'], [edge('f1', 'co_changed', 'f2'), edge('f2', 'co_changed', 'f1')]);
    expect(csr.edges).toHaveLength(1);
    expect(csr.targets.length).toBe(2);
  });

  it('symmetric co_changed edges are stored once and walkable from both ends', () => {
    const csr = buildCsr(['f1', 'f2'], [edge('f1', 'co_changed', 'f2')]);
    expect(arcs(csr, 'f1')).toEqual(['→co_changed:f2']);
    expect(arcs(csr, 'f2')).toEqual(['←co_changed:f1']);
  });
});

describe('csrFromGraph / csrFromEdges', () => {
  it('csrFromGraph on a real graph: 2 arcs per edge, sorted ids, learned edges merged in', async () => {
    const { graph } = await buildIndex(FIXTURE, undefined, { cache: false });
    const csr = csrFromGraph(graph);
    expect(csr.n).toBe(graph.nodes.length);
    expect(csr.targets.length).toBe(2 * graph.edges.length);
    expect(csr.ids).toEqual([...csr.ids].sort());
    const withLearned = csrFromGraph(graph, [edge('file:src/main.ts', 'co_changed', 'file:src/App.vue')]);
    expect(withLearned.targets.length).toBe(csr.targets.length + 2);
    // every graph edge is recoverable from its arcs
    const keys = new Set(csr.edges.map((e) => e.key));
    for (const e of graph.edges) expect(keys.has(e.key)).toBe(true);
  });

  it('csrFromEdges builds over just the endpoints (a HydraDB subgraph) and keeps isolated seeds', () => {
    const csr = csrFromEdges([edge('b', 'calls', 'a'), edge('c', 'imports', 'b')], ['z']);
    expect(csr.ids).toEqual(['a', 'b', 'c', 'z']);
    expect(arcs(csr, 'b')).toEqual(['→calls:a', '←imports:c']);
    expect(arcs(csr, 'z')).toEqual([]);
  });
});

describe.skipIf(!process.env.CLICK_PERF)('performance (CLICK_PERF=1)', () => {
  it('50k nodes / 200k edges build in under 300 ms', () => {
    const N = 50_000;
    const ids = Array.from({ length: N }, (_, i) => `n${String(i).padStart(6, '0')}`);
    let s = 1; // mulberry32: exact 32-bit integer arithmetic (a float LCG here loses precision and produces mostly duplicates)
    const rnd = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const es: CsrEdge[] = [];
    for (let k = 0; k < 200_000; k++) {
      const a = ids[Math.floor(rnd() * N)]!;
      const b = ids[Math.floor(rnd() * N)]!;
      es.push(edge(a, EDGE_KINDS[k % EDGE_KINDS.length]!, b));
    }
    const t = performance.now();
    const csr = buildCsr(ids, es);
    const ms = performance.now() - t;
    expect(csr.targets.length).toBeGreaterThan(300_000);
    expect(ms).toBeLessThan(300);
  });
});
