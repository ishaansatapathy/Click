import { describe, expect, it } from 'vitest';
import { buildCsr, type CsrEdge } from '../graph/csr.js';
import { pprPush } from '../graph/ppr.js';
import { applyWeights } from '../graph/weights.js';
import type { EdgeKind, GraphEdge, GraphNode, NodeKind, Seed } from '../types.js';
import { buildCandidateGraph, chunkCandidates, mentionsTests, pprCandidates, seedCandidates } from './candidates.js';

const node = (id: string, kind: NodeKind, name: string, path: string | null, startLine = 1): GraphNode => ({
  id, kind, path, name, tokens: 10, sigTokens: 2, fileHash: 'h', ...(path ? { range: { startLine, endLine: startLine + 5 } } : {}),
});
const e = (from: string, kind: EdgeKind, to: string): GraphEdge => ({ key: `${from}|${kind}|${to}`, from, to, kind });

const NODES: GraphNode[] = [
  node('file:cart', 'file', 'cart.ts', 'src/stores/cart.ts'),
  node('store:cart', 'store', 'useCartStore', 'src/stores/cart.ts', 3),
  node('fn:total', 'function', 'cartTotal', 'src/stores/cart.ts', 20),
  node('file:btn', 'file', 'CheckoutButton.vue', 'src/components/CheckoutButton.vue'),
  node('comp:btn', 'component', 'CheckoutButton', 'src/components/CheckoutButton.vue'),
  node('route:checkout', 'route', '/checkout', null),
  node('file:page', 'file', 'CheckoutPage.vue', 'src/pages/CheckoutPage.vue'),
  node('comp:page', 'component', 'CheckoutPage', 'src/pages/CheckoutPage.vue'),
  node('file:consts', 'file', 'consts.ts', 'src/consts.ts'), // a file with no symbols
  node('file:test', 'file', 'cart.spec.ts', 'src/stores/cart.spec.ts'),
  node('test:cart', 'test', 'cart store', 'src/stores/cart.spec.ts', 4),
  node('file:gen', 'file', 'api.gen.ts', 'src/api.gen.ts'),
  node('conv:1', 'convention', 'use pinia', null),
];
const EDGES: GraphEdge[] = [
  e('file:cart', 'contains', 'store:cart'), e('file:cart', 'contains', 'fn:total'),
  e('file:btn', 'contains', 'comp:btn'), e('file:page', 'contains', 'comp:page'),
  e('file:test', 'contains', 'test:cart'),
  e('route:checkout', 'routes_to', 'comp:page'),
  e('comp:page', 'uses_component', 'comp:btn'),
  e('comp:btn', 'uses_store', 'store:cart'),
  e('store:cart', 'tested_by', 'test:cart'),
  e('comp:page', 'imports', 'file:consts'),
];
const cg = buildCandidateGraph({ nodes: NODES, edges: EDGES });
const csr = applyWeights(buildCsr(NODES.map((n) => n.id), EDGES as CsrEdge[]), { usePriors: true, reverseScale: 1, useLearned: false });
const seed = (nodeId: string, score = 1, sources: Seed['sources'] = ['symbol']): Seed => ({ nodeId, score, sources });
const run = (seeds: Seed[], text = 'fix the checkout', limit = 40) =>
  pprCandidates(cg, csr, pprPush(csr, seeds), seeds, text, limit);
const ids = (cs: { nodeId: string }[]) => cs.map((c) => c.nodeId);

describe('pprCandidates (PROMPTS 090)', () => {
  it('returns units only, best first, with the seed ranked at the top and a "seed:" reason', () => {
    const cs = run([seed('comp:btn')]);
    expect(cs[0]!.nodeId).toBe('comp:btn');
    expect(cs[0]!.reasons[0]).toBe('seed: symbol match');
    expect(cs[0]!.via).toEqual([]);
    for (const c of cs) expect(['function', 'component', 'composable', 'store', 'type', 'file']).toContain(cg.nodes.get(c.nodeId)!.kind);
    expect(ids(cs)).not.toContain('conv:1');
    expect(ids(cs)).not.toContain('route:checkout');
    for (let i = 1; i < cs.length; i++) expect(cs[i - 1]!.score).toBeGreaterThanOrEqual(cs[i]!.score);
  });

  it('reached nodes carry the edge-key path and a "via <kind> from <name>" reason', () => {
    const store = run([seed('comp:btn')]).find((c) => c.nodeId === 'store:cart')!;
    expect(store.via).toEqual(['comp:btn|uses_store|store:cart']);
    expect(store.reasons[0]).toBe('via uses_store from CheckoutButton');
  });

  it('a route is never a candidate itself: the component it renders is, reached via routes_to', () => {
    const cs = run([seed('route:checkout')]);
    expect(cs[0]!.nodeId).toBe('comp:page');
    expect(ids(cs)).not.toContain('route:checkout');
    expect(cs[0]!.reasons[0]).toBe('via routes_to from /checkout');
    expect(cs[0]!.via).toEqual(['route:checkout|routes_to|comp:page']);
  });

  it('a file maps to its highest-scoring contained symbol; with no symbols it stays a whole-file unit', () => {
    const f = run([seed('file:cart')]);
    expect(f[0]!.nodeId).toBe('store:cart'); // contains both; tie on score keeps source order (store at line 3)
    expect(f[0]!.reasons).toContain('from file src/stores/cart.ts');
    expect(ids(f)).not.toContain('file:cart');
    const bare = run([seed('file:consts')]);
    const whole = bare.find((c) => c.nodeId === 'file:consts')!;
    expect(whole.reasons[0]).toBe('seed: symbol match');
  });

  it('a file score goes to the contained symbol that scores best on its own', () => {
    const cs = run([seed('file:cart', 0.5), seed('fn:total', 0.5)]);
    expect(cs[0]!.nodeId).toBe('fn:total');
  });

  it('excludes test and generated nodes unless the task mentions tests', () => {
    expect(ids(run([seed('store:cart')]))).not.toContain('test:cart');
    expect(ids(run([seed('store:cart')], 'fix the checkout'))).not.toContain('file:test');
    for (const word of ['add a test for the cart', 'update the spec', 'run vitest']) expect(ids(run([seed('store:cart')], word))).toContain('test:cart');
    expect(mentionsTests('the contest winner')).toBe(false);
    expect(mentionsTests('Fix failing Tests')).toBe(true);
  });

  it('honours the limit and is deterministic', () => {
    expect(run([seed('comp:btn')], 'x', 2)).toHaveLength(2);
    expect(run([seed('comp:btn')], 'x', 0)).toEqual([]);
    expect(run([seed('comp:btn')])).toEqual(run([seed('comp:btn')]));
  });

  it('several seed sources are all named in the reason', () => {
    const c = run([seed('comp:btn', 1, ['symbol', 'bm25'])])[0]!;
    expect(c.reasons[0]).toBe('seed: symbol match + bm25 match');
  });
});

describe('seedCandidates / chunkCandidates (expand: none)', () => {
  it('V2: the fused seeds are the candidates, mapped to units, ordered by seed score', () => {
    const cs = seedCandidates(cg, [seed('route:checkout', 0.2), seed('comp:btn', 0.5), seed('conv:1', 0.3)], 'fix', 10);
    expect(ids(cs)).toEqual(['comp:btn', 'comp:page']);
    expect(cs[0]!.pprScore).toBe(0.5);
    expect(cs[0]!.via).toEqual([]);
    expect(cs[1]!.reasons).toEqual(['seed: symbol match', 'from route /checkout']);
  });

  it('V2 keeps the strongest of several seeds that map to the same unit', () => {
    const cs = seedCandidates(cg, [seed('file:btn', 0.2), seed('comp:btn', 0.4)], 'fix', 10);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.score).toBe(0.4);
  });

  it('V1: chunk hits ranked by score, deduped, tests excluded unless asked for', () => {
    const hits = [
      { id: 'chunk:src/a.ts#fn#0', score: 0.5 },
      { id: 'chunk:src/a.spec.ts#t#0', score: 0.9 },
      { id: 'chunk:src/b.ts#fn#0', score: 0.7 },
      { id: 'chunk:src/b.ts#fn#0', score: 0.1 },
    ];
    expect(ids(chunkCandidates(hits, 'fix a bug', 10))).toEqual(['chunk:src/b.ts#fn#0', 'chunk:src/a.ts#fn#0']);
    expect(ids(chunkCandidates(hits, 'fix the spec', 10))[0]).toBe('chunk:src/a.spec.ts#t#0');
    expect(chunkCandidates(hits, 'x', 1)).toHaveLength(1);
    expect(chunkCandidates([], 'x', 5)).toEqual([]);
  });
});
