import { describe, expect, it } from 'vitest';
import type { Candidate, GraphNode, Task } from '../types.js';
import { Deadline } from '../util/deadline.js';
import { runPruneChain, type PruneConfig } from './chain.js';
import { nonePruner } from './none.js';
import { candidateLine, type CandidateView, type Pruner, type PrunerName } from './types.js';

const TASK: Task = { text: 'fix checkout', budgetTokens: 4000 };
const CFG: PruneConfig = { chain: ['jev', 'rerank', 'none'], threshold: 0.35, floor: 2, timeoutMs: 60, maxCandidates: 40 };

const cand = (nodeId: string, pprScore: number): Candidate => ({ nodeId, score: pprScore, pprScore, via: [], reasons: [] });
const nodes = new Map<string, Pick<GraphNode, 'path' | 'name' | 'kind' | 'signature'>>(
  ['a', 'b', 'c', 'd', 'e'].map((id) => [id, { path: `src/${id}.ts`, name: id, kind: 'function', signature: `function ${id}() { … }` }]),
);
const CANDS = [cand('a', 0.4), cand('b', 0.3), cand('c', 0.2), cand('d', 0.06), cand('e', 0.04)];

const fixed = (name: PrunerName, probs: Record<string, number>, enough?: number): Pruner => ({
  name,
  prune: () => Promise.resolve({ probs, ...(enough !== undefined ? { enough } : {}) }),
});
const slow = (name: PrunerName, ms: number): Pruner => ({
  name,
  prune: (_t, _c, ctx) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ probs: {} }), ms);
      ctx.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      });
    }),
});
const failing = (name: PrunerName): Pruner => ({ name, prune: () => Promise.reject(new Error('boom')) });

describe('runPruneChain (PROMPTS 091)', () => {
  it('none keeps everything in PPR order with prob 1 and score = ppr', async () => {
    const r = await runPruneChain(TASK, CANDS, nodes, {}, { ...CFG, chain: ['none'] });
    expect(r.candidates.map((c) => c.nodeId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(r.candidates.every((c) => c.keepProb === 1)).toBe(true);
    expect(r.candidates[0]!.score).toBeCloseTo(0.4);
    expect(r.fallbacks).toEqual([]);
    expect(r.used).toBe('none');
  });

  it('applies the keep rule (prob ≥ threshold OR top `floor` by PPR) and the final-score formula', async () => {
    const jev = fixed('jev', { a: 0.1, b: 0.9, c: 0.35, d: 0.2, e: 1 }, 0.8);
    const r = await runPruneChain(TASK, CANDS, nodes, { jev }, CFG);
    // a: kept by floor (rank 0) despite 0.1; b: kept; c: 0.35 ≥ threshold; d: dropped (0.2, rank 3); e: kept
    expect(r.candidates.map((c) => c.nodeId).sort()).toEqual(['a', 'b', 'c', 'e']);
    const score = (id: string) => r.candidates.find((c) => c.nodeId === id)!.score;
    expect(score('a')).toBeCloseTo(0.4 * (0.5 + 0.5 * 0.1));
    expect(score('b')).toBeCloseTo(0.3 * (0.5 + 0.5 * 0.9));
    expect(r.candidates.find((c) => c.nodeId === 'b')!.keepProb).toBe(0.9);
    expect(r.used).toBe('jev');
    expect(r.enough).toBe(0.8);
    expect(r.kept).toBe(4);
    expect(r.considered).toBe(5);
    // pruning reorders: b (0.3 × 0.95) now beats a (0.4 × 0.55)
    expect(r.candidates[0]!.nodeId).toBe('b');
  });

  it('a slow pruner times out, the chain falls through to the next and records it', async () => {
    const t0 = Date.now();
    const rerank = fixed('rerank', { a: 1, b: 1, c: 0, d: 0, e: 0 });
    const r = await runPruneChain(TASK, CANDS, nodes, { jev: slow('jev', 2_000), rerank }, CFG);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r.fallbacks).toEqual(['fallback:jev->rerank']);
    expect(r.used).toBe('rerank');
    expect(r.candidates.map((c) => c.nodeId).sort()).toEqual(['a', 'b']);
  });

  it('an error falls through the same way; two failures end at none', async () => {
    const r = await runPruneChain(TASK, CANDS, nodes, { jev: failing('jev'), rerank: failing('rerank') }, CFG);
    expect(r.fallbacks).toEqual(['fallback:jev->rerank', 'fallback:rerank->none']);
    expect(r.used).toBe('none');
    expect(r.candidates).toHaveLength(5);
  });

  it('a pruner that is not configured counts as a fallback; a chain without none still ends safely', async () => {
    const r = await runPruneChain(TASK, CANDS, nodes, {}, { ...CFG, chain: ['jev', 'rerank'] });
    expect(r.fallbacks).toEqual(['fallback:jev->rerank', 'fallback:rerank->none']);
    expect(r.candidates).toHaveLength(5);
    expect((await runPruneChain(TASK, CANDS, nodes, {}, { ...CFG, chain: [] })).candidates).toHaveLength(5);
  });

  it('each pruner gets at most the time left on the request deadline', async () => {
    let seen = 0;
    const spy: Pruner = { name: 'jev', prune: (_t, _c, ctx) => ((seen = ctx.deadlineMs), Promise.resolve({ probs: {} })) };
    await runPruneChain(TASK, CANDS, nodes, { jev: spy }, { ...CFG, timeoutMs: 500 }, new Deadline(40));
    expect(seen).toBeLessThanOrEqual(40);
    expect(seen).toBeGreaterThan(0);

    const expired = new Deadline(0);
    const r = await runPruneChain(TASK, CANDS, nodes, { jev: spy }, { ...CFG, chain: ['jev', 'none'], timeoutMs: 500 }, expired);
    expect(r.fallbacks).toEqual(['fallback:jev->none']);
    expect(r.candidates).toHaveLength(5);
  });

  it('missing, NaN and out-of-range probabilities are handled (missing = no opinion = 1, clamped to [0,1])', async () => {
    const r = await runPruneChain(TASK, CANDS, nodes, { jev: fixed('jev', { a: 7, b: Number.NaN, c: -3 }) }, { ...CFG, floor: 0 });
    const prob = (id: string) => r.candidates.find((c) => c.nodeId === id)?.keepProb;
    expect(prob('a')).toBe(1);
    expect(prob('b')).toBe(1);
    expect(prob('c')).toBeUndefined(); // clamped to 0, below threshold, no floor
    expect(prob('d')).toBe(1);
  });

  it('only the top maxCandidates by PPR are shown to the pruner, with the documented line format', async () => {
    let shown: CandidateView[] = [];
    const spy: Pruner = { name: 'jev', prune: (_t, c) => ((shown = c), Promise.resolve({ probs: {} })) };
    const r = await runPruneChain(TASK, CANDS, nodes, { jev: spy }, { ...CFG, maxCandidates: 3 });
    expect(shown.map((v) => v.nodeId)).toEqual(['a', 'b', 'c']);
    expect(shown[0]!.line).toBe('1 | src/a.ts | a | function | function a() { … } | 0.4000');
    expect(r.candidates.map((c) => c.nodeId)).toEqual(['a', 'b', 'c']);
  });

  it('empty candidates and the none pruner itself', async () => {
    const r = await runPruneChain(TASK, [], nodes, {}, CFG);
    expect(r).toMatchObject({ candidates: [], considered: 0, kept: 0, fallbacks: [] });
    const v = await nonePruner.prune(TASK, [{ nodeId: 'x', line: '1 | x' }], { deadlineMs: 1, signal: new AbortController().signal });
    expect(v.probs).toEqual({ x: 1 });
  });

  it('candidateLine truncates signatures to 120 characters and flattens whitespace', () => {
    const line = candidateLine(3, { path: null, name: 'f', kind: 'function', signature: `function f(\n  a,\n  b) ${'x'.repeat(200)}` }, 0.05);
    expect(line.startsWith('3 | - | f | function | function f( a, b) xxx')).toBe(true);
    expect(line.split(' | ')[4]!.length).toBe(120);
    expect(line.endsWith(' | 0.0500')).toBe(true);
  });
});
