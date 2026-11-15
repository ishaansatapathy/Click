import { describe, expect, it } from 'vitest';
import type { CheckResultEvent, ContextRecord, LogEvent, OutcomeEvent } from '../contracts.js';
import type { EdgeKind, GraphEdge, GraphNode, NodeKind } from '../types.js';
import { DEFAULT_PARAMS, deriveWeights, type GraphView } from './derive.js';

const file = (path: string): GraphNode => ({ id: `file:${path}`, kind: 'file', path, name: path.split('/').pop()!, tokens: 10, sigTokens: 0, fileHash: 'h' });
const sym = (path: string, name: string, kind: NodeKind = 'function'): GraphNode => ({ id: `sym:${path}#${name}`, kind, path, name, tokens: 5, sigTokens: 2, fileHash: 'h' });
const edge = (from: string, kind: EdgeKind, to: string): GraphEdge => ({ key: `${from}|${kind}|${to}`, from, to, kind });

// seed: Checkout (a.ts) --uses_store--> useOrder (b.ts) --calls--> fmt (c.ts); Checkout --calls--> noisy (d.ts); e.ts is imported by a.ts; z.ts is unrelated
const CHECKOUT = sym('src/a.ts', 'Checkout', 'component');
const USE_ORDER = sym('src/b.ts', 'useOrder', 'store');
const FMT = sym('src/c.ts', 'fmt');
const NOISY = sym('src/d.ts', 'noisy');
const HELPER = sym('src/e.ts', 'helper');
const OTHER = sym('src/z.ts', 'other');
const FILES = ['a', 'b', 'c', 'd', 'e', 'z', 'f'].map((n) => file(`src/${n}.ts`));
const GRAPH: GraphView = {
  nodes: [...FILES, CHECKOUT, USE_ORDER, FMT, NOISY, HELPER, OTHER],
  edges: [
    edge(CHECKOUT.id, 'uses_store', USE_ORDER.id),
    edge(USE_ORDER.id, 'calls', FMT.id),
    edge(CHECKOUT.id, 'calls', NOISY.id),
    edge('file:src/a.ts', 'imports', 'file:src/e.ts'),
  ],
};
const K_STORE = edge(CHECKOUT.id, 'uses_store', USE_ORDER.id).key;
const K_FMT = edge(USE_ORDER.id, 'calls', FMT.id).key;
const K_NOISY = edge(CHECKOUT.id, 'calls', NOISY.id).key;

let n = 0;
const ctx = (over: Partial<ContextRecord> = {}): ContextRecord => ({
  v: 1, contextId: `c${++n}`, ts: '2026-11-15T10:00:00.000Z', source: 'hook', variant: 'delivery', configHash: 'h', graphVersion: 'g', weightsVersion: null, taskText: 't', taskHash: 'th', repoCommit: null,
  seeds: [{ nodeId: CHECKOUT.id, score: 1 }],
  items: [CHECKOUT, USE_ORDER, FMT, NOISY].map((x) => ({ nodeId: x.id, mode: 'body' as const })),
  attribution: { [USE_ORDER.id]: [K_STORE], [FMT.id]: [K_STORE, K_FMT], [NOISY.id]: [K_NOISY] },
  tokens: 100, ms: 10, degraded: [], ...over,
});
let o = 0;
const outcome = (over: Partial<OutcomeEvent> & { contextIds: string[] }): OutcomeEvent => ({
  v: 1, type: 'outcome', id: `o${String(++o).padStart(4, '0')}`, ts: `2026-11-15T11:${String(o % 60).padStart(2, '0')}:00.000Z`, source: 'agent', filesRead: [], filesEdited: [], diffSymbols: [], check: { kind: 'vue-tsc', passed: true }, repoCommit: null, ...over,
});
const check = (outcomeId: string, passed: boolean): CheckResultEvent => ({ v: 1, type: 'check_result', id: `chk-${outcomeId}`, ts: '2026-11-15T12:00:00.000Z', outcomeId, passed, ms: 5 });

const run = (events: LogEvent[], contexts: ContextRecord[]) => deriveWeights(events, contexts, GRAPH);
const { alpha, beta } = DEFAULT_PARAMS;

describe('deriveWeights (PROMPTS 154, SPEC §15)', () => {
  it('rule 1: when the work passed, every edge on the path to a USED node is reinforced × (1 + α), once', () => {
    const c = ctx();
    // the agent edited fmt's file (c.ts): fmt is used. Its path is store + fmt edges.
    const doc = run([outcome({ contextIds: [c.contextId], filesEdited: ['src/c.ts'] })], [c]);
    expect(doc.multipliers[K_FMT]).toBeCloseTo(1 + alpha, 6);
    // (K_STORE is also the LAST edge of useOrder, which is unrelated to the edit: rule 2 decays it after rule 1 reinforced it)
    expect(doc.multipliers[K_STORE]).toBeCloseTo((1 + alpha) * (1 - beta), 6);
  });

  it('rule 1: a symbol name in diffSymbols counts as used just like an edited file', () => {
    const c = ctx();
    const doc = run([outcome({ contextIds: [c.contextId], diffSymbols: ['useOrder'] })], [c]);
    expect(doc.multipliers[K_STORE]).toBeCloseTo(1 + alpha, 6);
    expect(doc.multipliers[K_FMT]).toBeCloseTo(1 - beta, 6); // fmt was not used: only rule 2 touched it
  });

  it('rule 1: an edge shared by the paths of two used nodes is reinforced once per outcome, not twice', () => {
    const c = ctx();
    const doc = run([outcome({ contextIds: [c.contextId], filesEdited: ['src/b.ts', 'src/c.ts'] })], [c]); // useOrder and fmt both used; K_STORE is on both paths
    expect(doc.multipliers[K_STORE]).toBeCloseTo(1 + alpha, 6);
    expect(doc.multipliers[K_FMT]).toBeCloseTo(1 + alpha, 6);
  });

  it('rule 2: only the LAST edge to an unrelated, non-seed node decays × (1 − β)', () => {
    const c = ctx();
    // the agent edited only c.ts: noisy (d.ts) is unrelated; useOrder (b.ts) is not used and not imported-related either, so its last edge decays too
    const doc = run([outcome({ contextIds: [c.contextId], filesEdited: ['src/c.ts'] })], [c]);
    expect(doc.multipliers[K_NOISY]).toBeCloseTo(1 - beta, 6);
    // fmt is used, so its path was reinforced and is not decayed; K_STORE was reinforced by rule 1 (path of fmt) and also decays as the last edge of useOrder: 1.2 × 0.9
    expect(doc.multipliers[K_STORE]).toBeCloseTo((1 + alpha) * (1 - beta), 6);
    expect(doc.multipliers[K_FMT]).toBeCloseTo(1 + alpha, 6);
  });

  it('rule 2 spares seeds, used nodes, and nodes one `imports` hop from an edited file', () => {
    const helper = ctx({
      items: [CHECKOUT, HELPER, OTHER].map((x) => ({ nodeId: x.id, mode: 'body' as const })),
      attribution: { [HELPER.id]: ['kh'], [OTHER.id]: ['ko'] },
    });
    // a.ts imports e.ts, and the agent edited a.ts: helper (e.ts) is related. other (z.ts) is not.
    const doc = run([outcome({ contextIds: [helper.contextId], filesEdited: ['src/a.ts'] })], [helper]);
    expect(doc.multipliers.kh).toBeUndefined();
    expect(doc.multipliers.ko).toBeCloseTo(1 - beta, 6);
    // a seed is never decayed, even if nothing it touched was used
    const seedOnly = ctx({ items: [OTHER].map((x) => ({ nodeId: x.id, mode: 'body' as const })), seeds: [{ nodeId: OTHER.id, score: 1 }], attribution: { [OTHER.id]: ['ks'] } });
    expect(run([outcome({ contextIds: [seedOnly.contextId], filesEdited: ['src/f.ts'] })], [seedOnly]).multipliers.ks).toBeUndefined();
  });

  it('rule 3: an edited file the context missed gets a learned co_changed edge from the best seed\'s file; again → × (1 + α)', () => {
    const c = ctx({ seeds: [{ nodeId: NOISY.id, score: 0.2 }, { nodeId: CHECKOUT.id, score: 0.9 }] });
    const e1 = outcome({ contextIds: [c.contextId], filesEdited: ['src/f.ts'] }); // f.ts is nowhere in the context
    const once = run([e1], [c]);
    const key = 'file:src/a.ts|co_changed|file:src/f.ts';
    expect(once.addedEdges).toEqual([{ key, from: 'file:src/a.ts', to: 'file:src/f.ts', kind: 'co_changed', meta: { source: 'learned', support: 1 } }]);
    expect(once.multipliers[key]).toBe(1);
    const twice = run([e1, outcome({ contextIds: [c.contextId], filesEdited: ['src/f.ts'] })], [c]);
    expect(twice.addedEdges).toHaveLength(1);
    expect(twice.addedEdges[0]!.meta?.support).toBe(2);
    expect(twice.multipliers[key]).toBeCloseTo(1 + alpha, 6);
  });

  it('rule 3: the pair is undirected (the reverse key is the same edge), covered files and unknown files get nothing', () => {
    const c = ctx();
    const doc = run([
      outcome({ contextIds: [c.contextId], filesEdited: ['src/f.ts'] }),
      outcome({ contextIds: [ctx({ seeds: [{ nodeId: 'file:src/f.ts', score: 1 }], items: [] }).contextId], filesEdited: ['src/a.ts'] }),
    ], [c]);
    expect(doc.addedEdges).toHaveLength(1);
    const covered = run([outcome({ contextIds: [c.contextId], filesEdited: ['src/b.ts', 'src/not-in-graph.ts'] })], [c]);
    expect(covered.addedEdges).toEqual([]); // b.ts is in the context, the other file is not in the graph
  });

  it('rule 4: a failed or unknown result changes nothing', () => {
    const c = ctx();
    const failed = outcome({ contextIds: [c.contextId], filesEdited: ['src/c.ts', 'src/f.ts'], check: { kind: 'vue-tsc', passed: false } });
    const unknown = outcome({ contextIds: [c.contextId], filesEdited: ['src/c.ts'], check: { kind: 'none' } });
    const pending = outcome({ contextIds: [c.contextId], filesEdited: ['src/c.ts'], check: { kind: 'vue-tsc' } });
    for (const ev of [failed, unknown, pending]) {
      const doc = run([ev], [c]);
      expect(doc.multipliers).toEqual({});
      expect(doc.addedEdges).toEqual([]);
      expect(doc.events).toBe(1); // still counted as an event seen
    }
  });

  it('a later check_result decides an outcome whose check was still pending; the latest verdict wins', () => {
    const c = ctx();
    const pending = outcome({ contextIds: [c.contextId], filesEdited: ['src/c.ts'], check: { kind: 'vue-tsc' } });
    expect(run([pending, check(pending.id, true)], [c]).multipliers[K_FMT]).toBeCloseTo(1 + alpha, 6);
    expect(run([pending, check(pending.id, false)], [c]).multipliers).toEqual({});
    const later = { ...check(pending.id, false), id: 'chk-late', ts: '2026-11-15T13:00:00.000Z' };
    expect(run([pending, check(pending.id, true), later], [c]).multipliers).toEqual({});
    expect(run([pending, later, check(pending.id, true)], [c]).multipliers).toEqual({}); // order in the array does not matter: ts, id do
  });

  it('o.check.passed set on the outcome beats a check_result', () => {
    const c = ctx();
    const ev = outcome({ contextIds: [c.contextId], filesEdited: ['src/c.ts'], check: { kind: 'vue-tsc', passed: true } });
    expect(run([ev, check(ev.id, false)], [c]).multipliers[K_FMT]).toBeCloseTo(1 + alpha, 6);
  });

  it('clamps every multiplier to [min, max] after each update', () => {
    const c = ctx();
    const many = Array.from({ length: 40 }, () => outcome({ contextIds: [c.contextId], filesEdited: ['src/c.ts'] }));
    const up = run(many, [c]);
    expect(up.multipliers[K_FMT]).toBe(DEFAULT_PARAMS.max);
    const noisy = Array.from({ length: 80 }, () => outcome({ contextIds: [c.contextId], filesEdited: ['src/c.ts'] }));
    expect(run(noisy, [c]).multipliers[K_NOISY]).toBe(DEFAULT_PARAMS.min); // decayed every time, never below min
    const tight = deriveWeights(many, [c], GRAPH, { alpha: 0.5, beta: 0.1, min: 0.5, max: 1.2 });
    expect(tight.multipliers[K_FMT]).toBe(1.2);
  });

  it('outcomes are processed in (ts, id) order whatever order they arrive in', () => {
    const c = ctx();
    const a = outcome({ contextIds: [c.contextId], filesEdited: ['src/c.ts'], ts: '2026-11-15T09:00:00.000Z' });
    const b = outcome({ contextIds: [c.contextId], filesEdited: ['src/b.ts'], ts: '2026-11-15T09:30:00.000Z' });
    const d = outcome({ contextIds: [c.contextId], filesEdited: ['src/z.ts'], ts: '2026-11-15T09:30:00.000Z' });
    const first = run([a, b, d], [c]);
    for (const perm of [[d, b, a], [b, a, d], [a, d, b]]) expect(JSON.stringify(run(perm, [c]))).toBe(JSON.stringify(first));
    expect(first.derivedFrom).toBe([a, b, d].sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : x.id < y.id ? -1 : 1)).at(-1)!.id);
  });

  it('is deterministic: the same input twice gives byte-identical JSON, and the version is the hash of params, multipliers and added edges', () => {
    const c = ctx({ seeds: [{ nodeId: CHECKOUT.id, score: 1 }] });
    const events = [outcome({ contextIds: [c.contextId], filesEdited: ['src/c.ts', 'src/f.ts'] }), outcome({ contextIds: [c.contextId], filesEdited: ['src/b.ts'] })];
    const a = JSON.stringify(run(events, [c]));
    expect(JSON.stringify(run(events, [c]))).toBe(a);
    expect(JSON.stringify(run([...events].reverse(), [c]))).toBe(a);
    const doc = run(events, [c]);
    expect(doc.version).toMatch(/^[0-9a-f]{12}$/);
    const changed = run([events[0]!], [c]);
    expect(changed.version).not.toBe(doc.version);
    expect(Object.keys(doc.multipliers)).toEqual([...Object.keys(doc.multipliers)].sort()); // keys sorted: stable files
    expect(doc).toMatchObject({ v: 1, params: DEFAULT_PARAMS, events: 2 });
  });

  it('no events, or outcomes whose contexts are unknown: an empty doc, never a throw', () => {
    expect(run([], [])).toMatchObject({ multipliers: {}, addedEdges: [], events: 0, derivedFrom: null });
    const ev = outcome({ contextIds: ['missing-context'], filesEdited: ['src/c.ts'] });
    expect(run([ev], [])).toMatchObject({ multipliers: {}, addedEdges: [], events: 1 });
  });

  it('nodes that are no longer in the graph (the index moved on) are ignored safely', () => {
    const gone = ctx({ items: [{ nodeId: 'sym:src/deleted.ts#x', mode: 'body' }], attribution: { 'sym:src/deleted.ts#x': ['k1'] } });
    const doc = run([outcome({ contextIds: [gone.contextId], filesEdited: ['src/c.ts'] })], [gone]);
    // nothing for the vanished node; the edited file is not covered by the context, so rule 3 still adds its shortcut
    expect(Object.keys(doc.multipliers)).toEqual(['file:src/a.ts|co_changed|file:src/c.ts']);
    expect(doc.multipliers.k1).toBeUndefined();
  });

  it('merged contexts: the first context to attribute a node wins', () => {
    const c1 = ctx({ attribution: { [FMT.id]: [K_STORE, K_FMT] }, items: [{ nodeId: FMT.id, mode: 'body' }], seeds: [{ nodeId: CHECKOUT.id, score: 1 }] });
    const c2 = ctx({ attribution: { [FMT.id]: ['other-path'] }, items: [{ nodeId: FMT.id, mode: 'body' }], seeds: [{ nodeId: CHECKOUT.id, score: 1 }] });
    const doc = run([outcome({ contextIds: [c1.contextId, c2.contextId], filesEdited: ['src/c.ts'] })], [c1, c2]);
    expect(doc.multipliers[K_FMT]).toBeCloseTo(1 + alpha, 6);
    expect(doc.multipliers['other-path']).toBeUndefined();
  });

  it('derives 10,000 events well under the 1 s budget (measured in the fast suite with generous slack)', () => {
    const c = ctx();
    const events: LogEvent[] = Array.from({ length: 10_000 }, (_, i) => outcome({ contextIds: [c.contextId], filesEdited: [i % 3 === 0 ? 'src/c.ts' : i % 3 === 1 ? 'src/b.ts' : 'src/f.ts'], ts: `2026-11-15T10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.${String(i % 1000).padStart(3, '0')}Z` }));
    const t0 = performance.now();
    const doc = run(events, [c]);
    const ms = performance.now() - t0;
    expect(doc.events).toBe(10_000);
    expect(ms).toBeLessThan(3_000);
    process.stdout.write(`deriveWeights over 10k events: ${ms.toFixed(0)} ms\n`);
  });
});
