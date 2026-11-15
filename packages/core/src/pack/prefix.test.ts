import { describe, expect, it } from 'vitest';
import { buildCsr, type CsrEdge } from '../graph/csr.js';
import { applyWeights } from '../graph/weights.js';
import { FakeGraphStore } from '../testing/fakes.js';
import type { Convention, EdgeKind, GraphEdge, GraphNode, NodeKind } from '../types.js';
import { conventionLines, globalPageRank, SkeletonProvider, type SkeletonSource } from './prefix.js';

const node = (id: string, kind: NodeKind = 'function', signature: string | undefined = `function ${id}() { … }`): GraphNode => ({
  id, kind, path: `src/${id}.ts`, name: id, ...(signature ? { signature } : {}), tokens: 5, sigTokens: 3, fileHash: 'h',
});
const edge = (from: string, kind: EdgeKind, to: string): GraphEdge => ({ key: `${from}|${kind}|${to}`, from, to, kind });

// everything points at `core`; `util` is used by two things; a file node is also popular but has no signature
const NODES = [node('core'), node('util'), node('a'), node('b'), node('c'), node('d'), node('file', 'file', undefined)];
const EDGES = [
  edge('a', 'calls', 'core'), edge('b', 'calls', 'core'), edge('c', 'calls', 'core'), edge('d', 'calls', 'core'),
  edge('a', 'calls', 'util'), edge('b', 'calls', 'util'), edge('d', 'contains', 'file'), edge('c', 'contains', 'file'), edge('a', 'contains', 'file'),
];
const csrOf = () => applyWeights(buildCsr(NODES.map((n) => n.id), EDGES as CsrEdge[]), { usePriors: true, reverseScale: 1, useLearned: false });
const source = (version = 'v1'): SkeletonSource => ({ version, nodes: new Map(NODES.map((n) => [n.id, n])), csr: csrOf });

const conv = (id: string, text: string, validTo: string | null = null): Convention => ({ id, text, source: 'x', validFrom: '2026-01-01', validTo });

describe('conventionLines (PROMPTS 093)', () => {
  it('only current conventions, one tidy line each, in a stable order', () => {
    expect(conventionLines([conv('conv:b', 'Use  Pinia\nsetup stores'), conv('conv:old', 'Options API', '2026-05-01'), conv('conv:a', 'Components use <script setup>')])).toEqual([
      '- Components use <script setup>',
      '- Use Pinia setup stores',
    ]);
    expect(conventionLines([])).toEqual([]);
  });
});

describe('globalPageRank', () => {
  it('sums to 1 and ranks the most depended-on node first, with a dangling node in the graph', () => {
    const csr = csrOf();
    const pr = globalPageRank(csr);
    expect(pr.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    const order = [...pr.keys()].sort((x, y) => pr[y]! - pr[x]!).map((i) => csr.ids[i]);
    expect(order[0]).toBe('core');
    expect(globalPageRank(buildCsr([], [])).length).toBe(0);
  });
});

describe('SkeletonProvider (PROMPTS 093)', () => {
  it('uses HydraDB hubs when available, keeps only nodes with a signature and path, and caches per graph version', async () => {
    const gs = new FakeGraphStore();
    await gs.upsertGraph({ nodes: NODES, edges: EDGES }, 'v1');
    const p = new SkeletonProvider({ graphStore: gs });
    const s = await p.get(source());
    expect(s.source).toBe('hydra');
    expect(s.lines[0]).toBe('- src/core.ts: function core() { … }');
    expect(s.lines.join('\n')).not.toContain('src/file.ts'); // no signature → not in the skeleton
    const before = gs.calls;
    await p.get(source());
    expect(gs.calls).toBe(before); // cached
    expect(p.stats).toMatchObject({ hydra: 1, hits: 1 });
    await p.get(source('v2'));
    expect(gs.calls).toBe(before + 1); // new version recomputes
  });

  it('falls back to the local PageRank on the replica when HydraDB fails or is slow', async () => {
    const failing = new SkeletonProvider({ graphStore: new FakeGraphStore({ failWith: new Error('down') }) });
    const f = await failing.get(source());
    expect(f.source).toBe('local');
    expect(f.lines[0]).toBe('- src/core.ts: function core() { … }');

    const t0 = Date.now();
    const slow = new SkeletonProvider({ graphStore: new FakeGraphStore({ latencyMs: 3_000 }), hubsTimeoutMs: 40 });
    const s = await slow.get(source());
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(s.source).toBe('local');
    expect(s.lines.length).toBeGreaterThan(0);
  });

  it('works without any graph store, and caps the skeleton size', async () => {
    const p = new SkeletonProvider({ size: 2 });
    const s = await p.get(source());
    expect(s.source).toBe('local');
    expect(s.lines).toHaveLength(2);
  });

  it('an empty HydraDB answer also falls back to local', async () => {
    const p = new SkeletonProvider({ graphStore: new FakeGraphStore() }); // knows no nodes
    expect((await p.get(source())).source).toBe('local');
  });

  it('takes the top 15 by default', async () => {
    const many = Array.from({ length: 40 }, (_, i) => node(`n${String(i).padStart(2, '0')}`));
    const csr = applyWeights(buildCsr(many.map((n) => n.id), []), { usePriors: true, reverseScale: 1, useLearned: false });
    const s = await new SkeletonProvider().get({ version: 'x', nodes: new Map(many.map((n) => [n.id, n])), csr: () => csr });
    expect(s.lines).toHaveLength(15);
  });
});
