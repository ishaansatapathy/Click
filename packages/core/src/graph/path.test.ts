import { describe, expect, it } from 'vitest';
import type { EdgeKind } from '../types.js';
import { buildCsr, type CsrEdge } from './csr.js';
import { attributionPath } from './path.js';
import { pprPush, type PprResult, type Via } from './ppr.js';
import { applyWeights } from './weights.js';

const edge = (from: string, kind: EdgeKind, to: string): CsrEdge => ({ key: `${from}|${kind}|${to}`, from, to, kind });
const csrOf = (ids: string[], edges: CsrEdge[]) => applyWeights(buildCsr(ids, edges), { usePriors: true, reverseScale: 1, useLearned: false });

/** The arc of csr that runs u → v, whichever edge direction it follows. */
function arc(csr: ReturnType<typeof csrOf>, u: string, v: string): number {
  const ui = csr.index.get(u)!;
  const vi = csr.index.get(v)!;
  for (let a = csr.offsets[ui]!; a < csr.offsets[ui + 1]!; a++) if (csr.targets[a] === vi) return a;
  throw new Error(`no arc ${u} → ${v}`);
}
const via = (csr: ReturnType<typeof csrOf>, pairs: [string, string][]): Map<number, Via> =>
  new Map(pairs.map(([from, to]) => [csr.index.get(to)!, { from: csr.index.get(from)!, arc: arc(csr, from, to) }]));

describe('attributionPath (PROMPTS 089)', () => {
  it('traces a real PPR result back to the seed, in seed → node order', () => {
    const csr = csrOf(['a', 'b', 'c', 'd'], [edge('a', 'uses_store', 'b'), edge('b', 'calls', 'c'), edge('c', 'calls', 'd')]);
    const res = pprPush(csr, [{ nodeId: 'a', score: 1 }]);
    const p = attributionPath(csr, res, 'd');
    expect(p.seedId).toBe('a');
    expect(p.nodeIds).toEqual(['a', 'b', 'c', 'd']);
    expect(p.edgeKeys).toEqual(['a|uses_store|b', 'b|calls|c', 'c|calls|d']);
  });

  it('a seed has an empty path and is its own seed', () => {
    const csr = csrOf(['a', 'b'], [edge('a', 'calls', 'b')]);
    const res = pprPush(csr, [{ nodeId: 'a', score: 1 }]);
    expect(attributionPath(csr, res, 'a')).toEqual({ edgeKeys: [], nodeIds: ['a'], seedId: 'a' });
  });

  it('follows edges backwards too, and reports the edge as stored', () => {
    const csr = csrOf(['a', 'b'], [edge('b', 'calls', 'a')]); // b calls a; walking a → b is the reverse direction
    const res = pprPush(csr, [{ nodeId: 'a', score: 1 }]);
    expect(attributionPath(csr, res, 'b').edgeKeys).toEqual(['b|calls|a']);
  });

  it('is cycle-safe: pointers b ← c ← b never loop, and the path is reported as unanchored', () => {
    const csr = csrOf(['s', 'b', 'c'], [edge('b', 'calls', 'c'), edge('c', 'calls', 'b')]);
    const cyc: Pick<PprResult, 'via' | 'seedIdx'> = { via: via(csr, [['b', 'c'], ['c', 'b']]), seedIdx: new Set([csr.index.get('s')!]) };
    const p = attributionPath(csr, cyc, 'c');
    expect(p.seedId).toBeNull();
    expect(p.nodeIds).toEqual(['b', 'c']);
    expect(p.edgeKeys).toHaveLength(1);
  });

  it('a cycle that runs through the seed still ends at the seed', () => {
    const csr = csrOf(['a', 'b', 'c'], [edge('a', 'calls', 'b'), edge('b', 'calls', 'c'), edge('c', 'calls', 'a')]);
    const res = pprPush(csr, [{ nodeId: 'a', score: 1 }]);
    for (const n of ['a', 'b', 'c']) {
      const p = attributionPath(csr, res, n);
      expect(p.seedId).toBe('a');
      expect(p.nodeIds[0]).toBe('a');
      expect(p.nodeIds.at(-1)).toBe(n);
    }
  });

  it('stops after 8 hops by default (and is unanchored), a bigger limit reaches the seed', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const edges = ids.slice(1).map((id, i) => edge(ids[i]!, 'calls', id));
    const csr = csrOf(ids, edges);
    const res = pprPush(csr, [{ nodeId: 'n0', score: 1 }]);
    const short = attributionPath(csr, res, 'n11');
    expect(short.edgeKeys).toHaveLength(8);
    expect(short.seedId).toBeNull();
    expect(short.nodeIds.at(-1)).toBe('n11');
    const long = attributionPath(csr, res, 'n11', 20);
    expect(long.edgeKeys).toHaveLength(11);
    expect(long.seedId).toBe('n0');
  });

  it('unknown or unreached nodes give an empty, unanchored path', () => {
    const csr = csrOf(['a', 'b', 'z'], [edge('a', 'calls', 'b')]);
    const res = pprPush(csr, [{ nodeId: 'a', score: 1 }]);
    expect(attributionPath(csr, res, 'ghost')).toEqual({ edgeKeys: [], nodeIds: [], seedId: null });
    expect(attributionPath(csr, res, 'z')).toEqual({ edgeKeys: [], nodeIds: ['z'], seedId: null });
    expect(attributionPath(csr, res, 99)).toEqual({ edgeKeys: [], nodeIds: [], seedId: null });
  });

  it('with several seeds, ends at whichever seed delivered the most mass', () => {
    const csr = csrOf(['a', 'b', 'x'], [edge('a', 'uses_store', 'x'), edge('b', 'has_type', 'x')]);
    const res = pprPush(csr, [{ nodeId: 'a', score: 0.5 }, { nodeId: 'b', score: 0.5 }]);
    expect(attributionPath(csr, res, 'x').seedId).toBe('a'); // uses_store (1.2) outweighs has_type (0.5)
  });
});
