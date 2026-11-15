import { describe, expect, it } from 'vitest';
import { fuseSeeds, type FuseConfig } from './fuse.js';

const CFG: FuseConfig = { sources: ['symbol', 'bm25', 'semantic'], weights: { symbol: 1.5, bm25: 1, semantic: 1 }, count: 8, rrfK: 60 };
const list = (...ids: string[]) => ids.map((id, i) => ({ id, score: 100 - i }));

// symbol and bm25 agree on s1..s8; semantic ranks x1..x7, none of which they found
const lists = {
  symbol: list('s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'),
  bm25: list('s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'),
  semantic: list('x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7'),
};
const ids = (cfg: Partial<FuseConfig> = {}, l: Parameters<typeof fuseSeeds>[0] = lists, resolve?: (id: string) => string): string[] =>
  fuseSeeds(l, { ...CFG, ...cfg }, resolve).map((s) => s.nodeId);

describe('semantic reservation: hybrid fusion keeps the best semantic seeds', () => {
  it('without the reservation the lexical crowd evicts every semantic node; with it the best five survive', () => {
    expect(ids({ semanticReserve: 0 }).filter((i) => i.startsWith('x'))).toEqual([]);
    const kept = ids();
    expect(kept).toHaveLength(8);
    expect(kept.filter((i) => i.startsWith('x')).sort()).toEqual(['x1', 'x2', 'x3', 'x4', 'x5']);
    expect(kept.filter((i) => i.startsWith('s')).sort()).toEqual(['s1', 's2', 's3']); // the other 3 slots follow weighted-RRF order
  });

  it('semantic nodes are deduplicated through the chunk resolver before the quota is counted', () => {
    const resolve = (id: string) => (id.startsWith('chunk:x1') ? 'fn:x1' : id.startsWith('chunk:x2') ? 'fn:x2' : id);
    const l = { ...lists, semantic: list('chunk:x1#0', 'chunk:x1#1', 'chunk:x1#2', 'chunk:x2#0', 'chunk:x2#1', 'x3', 'x4', 'x5', 'x6') };
    const kept = ids({}, l, resolve);
    expect(kept.filter((i) => !i.startsWith('s')).sort()).toEqual(['fn:x1', 'fn:x2', 'x3', 'x4', 'x5']); // five unique nodes, not five chunks
    expect(kept).toHaveLength(8);
  });

  it('fewer than five semantic hits reserve only what exists; the rest is ordinary fusion', () => {
    const kept = ids({}, { ...lists, semantic: list('x1', 'x2') });
    expect(kept.filter((i) => i.startsWith('x')).sort()).toEqual(['x1', 'x2']);
    expect(kept.filter((i) => i.startsWith('s'))).toHaveLength(6);
    expect(ids({}, { ...lists, semantic: [] }).sort()).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']);
  });

  it('a node found by semantic and by the lexical lists takes one slot, not two', () => {
    const kept = ids({}, { ...lists, semantic: list('s1', 'x1', 'x2', 'x3', 'x4', 'x5') });
    expect(new Set(kept).size).toBe(kept.length);
    expect(kept).toHaveLength(8);
    for (const id of ['s1', 'x1', 'x2', 'x3', 'x4']) expect(kept).toContain(id); // the first five unique semantic nodes
    expect(kept).not.toContain('x5');
  });

  it('is deterministic: ordered by fused score then id, and normalised to sum 1', () => {
    const a = fuseSeeds(lists, CFG);
    expect(fuseSeeds(lists, CFG)).toEqual(a);
    for (let i = 1; i < a.length; i++) {
      const prev = a[i - 1]!;
      const cur = a[i]!;
      expect(prev.score > cur.score || (prev.score === cur.score && prev.nodeId < cur.nodeId)).toBe(true);
    }
    expect(a.reduce((x, s) => x + s.score, 0)).toBeCloseTo(1, 10);
  });

  it('keeps source attribution: a reserved node lists every source that found it', () => {
    const kept = fuseSeeds({ ...lists, semantic: list('s1', 'x1', 'x2', 'x3', 'x4') }, CFG);
    expect(kept.find((s) => s.nodeId === 's1')!.sources).toEqual(['symbol', 'bm25', 'semantic']);
    expect(kept.find((s) => s.nodeId === 'x1')!.sources).toEqual(['semantic']);
  });

  it('no quota for semantic-only, semantic-off (not configured, or weight 0); the quota never exceeds the seed count', () => {
    expect(ids({ sources: ['semantic'] })).toEqual(['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7']); // plain RRF, only 7 exist
    expect(ids({ sources: ['symbol', 'bm25'] }).some((i) => i.startsWith('x'))).toBe(false);
    expect(ids({ weights: { symbol: 1.5, bm25: 1, semantic: 0 } }).some((i) => i.startsWith('x'))).toBe(false);
    expect(ids({ sources: ['semantic', 'symbol'], weights: { symbol: 0, bm25: 1, semantic: 1 } })).toEqual(['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7']); // the "other" source has no weight
    expect(ids({ count: 3 }).sort()).toEqual(['x1', 'x2', 'x3']);
    expect(ids({ semanticReserve: 2 }).filter((i) => i.startsWith('x')).sort()).toEqual(['x1', 'x2']);
  });

  it('a ground-truth node at semantic rank 2, 3, 4 or 5 survives even when the lexical lists disagree with it', () => {
    for (let rank = 1; rank <= 5; rank++) {
      const sem = list('a', 'b', 'c', 'd', 'e', 'f', 'g');
      expect(ids({}, { ...lists, semantic: sem })).toContain(sem[rank - 1]!.id);
    }
    expect(ids({}, { ...lists, semantic: list('a', 'b', 'c', 'd', 'e', 'f', 'g') })).not.toContain('f'); // rank 6 is not reserved
  });
});
