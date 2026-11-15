import { describe, expect, it } from 'vitest';
import { chunkResolver, fuseSeeds, type FuseConfig } from './fuse.js';

const CFG: FuseConfig = { sources: ['symbol', 'bm25', 'semantic'], weights: { symbol: 1.5, bm25: 1, semantic: 1 }, count: 8, rrfK: 60 };
const list = (...ids: string[]) => ids.map((id, i) => ({ id, score: 100 - i }));
const sum = (xs: { score: number }[]) => xs.reduce((a, x) => a + x.score, 0);

describe('fuseSeeds (PROMPTS 087)', () => {
  it('weighted RRF: score = Σ w / (k + rank)', () => {
    const r = fuseSeeds({ symbol: list('a', 'b'), bm25: list('b', 'c') }, CFG);
    const raw: Record<string, number> = { a: 1.5 / 61, b: 1.5 / 62 + 1 / 61, c: 1 / 62 };
    const total = raw.a! + raw.b! + raw.c!;
    expect(r.map((s) => s.nodeId)).toEqual(['b', 'a', 'c']);
    for (const s of r) expect(s.score).toBeCloseTo(raw[s.nodeId]! / total, 10);
  });

  it('seed scores are normalised to sum to 1 and every seed records the sources that found it', () => {
    const r = fuseSeeds({ symbol: list('a'), bm25: list('a', 'b'), semantic: list('c') }, CFG);
    expect(sum(r)).toBeCloseTo(1, 10);
    expect(r.find((s) => s.nodeId === 'a')!.sources).toEqual(['symbol', 'bm25']);
    expect(r.find((s) => s.nodeId === 'c')!.sources).toEqual(['semantic']);
  });

  it('semantic chunk hits map to their parent node; several chunks of one node count once at the best rank', () => {
    const resolve = chunkResolver({ chunks: [
      { id: 'chunk:1', nodeId: 'fn:x', path: 'x.ts', range: { startLine: 1, endLine: 2 } },
      { id: 'chunk:2', nodeId: 'fn:x', path: 'x.ts', range: { startLine: 3, endLine: 4 } },
      { id: 'chunk:3', nodeId: 'fn:y', path: 'y.ts', range: { startLine: 1, endLine: 2 } },
    ] });
    const r = fuseSeeds({ semantic: list('chunk:1', 'chunk:2', 'chunk:3') }, CFG, resolve);
    expect(r.map((s) => s.nodeId)).toEqual(['fn:x', 'fn:y']);
    // fn:y is rank 2 (not 3): the duplicate chunk did not push it down
    expect(r[0]!.score / r[1]!.score).toBeCloseTo((1 / 61) / (1 / 62), 10);
    expect(resolve('fn:already-a-node')).toBe('fn:already-a-node');
  });

  it('only configured sources with positive weight count', () => {
    const lists = { symbol: list('a'), bm25: list('b'), semantic: list('c') };
    expect(fuseSeeds(lists, { ...CFG, sources: ['bm25'] }).map((s) => s.nodeId)).toEqual(['b']);
    expect(fuseSeeds(lists, { ...CFG, weights: { symbol: 0, bm25: 1, semantic: 1 } }).map((s) => s.nodeId)).toEqual(['b', 'c']);
  });

  it('keeps the top `count` and renormalises over them', () => {
    const r = fuseSeeds({ bm25: list('a', 'b', 'c', 'd') }, { ...CFG, count: 2 });
    expect(r.map((s) => s.nodeId)).toEqual(['a', 'b']);
    expect(sum(r)).toBeCloseTo(1, 10);
  });

  it('is deterministic: equal fused scores order by id, input order does not matter', () => {
    const a = fuseSeeds({ symbol: [{ id: 'z', score: 1 }, { id: 'a', score: 1 }] , bm25: [{ id: 'm', score: 1 }] }, CFG);
    const b = fuseSeeds({ bm25: [{ id: 'm', score: 1 }], symbol: [{ id: 'a', score: 1 }, { id: 'z', score: 1 }] }, CFG);
    expect(a).toEqual(b);
    expect(a.map((s) => s.nodeId)).toEqual(['a', 'z', 'm']);
  });

  it('empty inputs give no seeds', () => {
    expect(fuseSeeds({}, CFG)).toEqual([]);
    expect(fuseSeeds({ symbol: [] }, CFG)).toEqual([]);
    expect(fuseSeeds({ symbol: list('a') }, { ...CFG, count: 0 })).toEqual([]);
  });

  it('a node found by several sources outranks one found by a single source at a better rank', () => {
    const r = fuseSeeds({ symbol: list('solo', 'both'), bm25: list('x', 'both'), semantic: list('y', 'both') }, CFG);
    expect(r[0]!.nodeId).toBe('both');
  });
});
