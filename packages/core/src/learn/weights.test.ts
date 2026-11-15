import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeGraphStore } from '../testing/fakes.js';
import type { GraphEdge, GraphNode, WeightsDoc } from '../types.js';
import { addedEdgesDiff, multiplierDiff, validateWeightsDoc, WeightsFile, WeightSync } from './weights.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'click-weights-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const co = (from: string, to: string): GraphEdge => ({ key: `${from}|co_changed|${to}`, from, to, kind: 'co_changed', meta: { source: 'learned', support: 1 } });
const doc = (version: string, multipliers: Record<string, number> = {}, addedEdges: GraphEdge[] = []): WeightsDoc => ({
  v: 1, version, derivedFrom: null, events: 1, params: { alpha: 0.2, beta: 0.1, min: 0.1, max: 5 }, multipliers, addedEdges,
});
const node = (id: string): GraphNode => ({ id, kind: 'file', path: id.slice(5), name: id, tokens: 1, sigTokens: 0, fileHash: 'h' });
const edge = (from: string, to: string): GraphEdge => ({ key: `${from}|imports|${to}`, from, to, kind: 'imports' });

describe('WeightsFile (PROMPTS 155)', () => {
  it('saves atomically, keeps the previous version as weights.prev.json, and round-trips', async () => {
    const f = new WeightsFile(dir);
    expect(await f.load()).toBeNull();
    expect(await f.save(doc('v1', { a: 1.2 }))).toBe(true);
    expect(existsSync(f.prev)).toBe(false);
    expect(await f.save(doc('v2', { a: 1.44 }))).toBe(true);
    expect((await f.load())?.version).toBe('v2');
    expect((await f.loadPrevious())?.version).toBe('v1');
    expect(await f.save(doc('v3'))).toBe(true);
    expect((await f.loadPrevious())?.version).toBe('v2'); // only one step back is kept
    expect(readFileSync(f.current, 'utf8').endsWith('\n')).toBe(true);
  });

  it('saving the version that is already current is a no-op (the previous version is not overwritten)', async () => {
    const f = new WeightsFile(dir);
    await f.save(doc('v1'));
    await f.save(doc('v2'));
    expect(await f.save(doc('v2'))).toBe(false);
    expect((await f.loadPrevious())?.version).toBe('v1');
  });

  it('rollback makes the previous version current, and the replaced one becomes the new previous (so it can be undone)', async () => {
    const f = new WeightsFile(dir);
    expect(await f.rollback()).toBeNull();
    await f.save(doc('v1', { a: 2 }));
    expect(await f.rollback()).toBeNull(); // nothing before v1
    await f.save(doc('v2', { a: 3 }));
    const r = await f.rollback();
    expect(r?.from.version).toBe('v2');
    expect(r?.to.version).toBe('v1');
    expect((await f.load())?.version).toBe('v1');
    expect((await f.loadPrevious())?.version).toBe('v2');
    await f.rollback(); // undo
    expect((await f.load())?.version).toBe('v2');
  });

  it('a missing, truncated or malformed file reads as "no weights", never throws', async () => {
    const f = new WeightsFile(dir);
    writeFileSync(f.current, '{ "v": 1, "versio');
    expect(await f.load()).toBeNull();
    writeFileSync(f.current, JSON.stringify({ v: 1, version: 'x', events: 1, params: { alpha: 1, beta: 1, min: 0, max: 1 }, multipliers: { a: 'high' }, addedEdges: [] }));
    expect(await f.load()).toBeNull();
    writeFileSync(f.current, JSON.stringify(doc('ok', { a: 1.5 })));
    expect((await f.load())?.multipliers.a).toBe(1.5);
  });

  it('validateWeightsDoc checks the parts the pipeline relies on', () => {
    expect(validateWeightsDoc(doc('v', { a: 1 }))).not.toBeNull();
    for (const bad of [null, [], { v: 2 }, { ...doc('v'), multipliers: { a: 0 } }, { ...doc('v'), multipliers: { a: Number.NaN } }, { ...doc('v'), addedEdges: [{ key: 'k' }] }, { ...doc('v'), params: { alpha: 1 } }, { ...doc('v'), addedEdges: [edge('file:a', 'file:b')] }]) {
      expect(validateWeightsDoc(bad)).toBeNull();
    }
  });
});

describe('multiplierDiff / addedEdgesDiff', () => {
  it('changed and new keys are updates; keys that vanished go back to 1; unchanged keys are left out; sorted', () => {
    expect(multiplierDiff(doc('a', { x: 1.2, y: 2, z: 0.5 }), doc('b', { x: 1.2, y: 3, w: 1.1 }))).toEqual([
      { key: 'w', w: 1.1 },
      { key: 'y', w: 3 },
      { key: 'z', w: 1 },
    ]);
    expect(multiplierDiff(null, doc('b', { q: 2 }))).toEqual([{ key: 'q', w: 2 }]);
    expect(multiplierDiff(doc('a', { q: 2 }), doc('a2', { q: 2 }))).toEqual([]);
  });
  it('only learned edges that are new', () => {
    const e1 = co('file:a', 'file:b');
    const e2 = co('file:a', 'file:c');
    expect(addedEdgesDiff(doc('a', {}, [e1]), doc('b', {}, [e1, e2]))).toEqual([e2]);
    expect(addedEdgesDiff(null, doc('b', {}, [e1]))).toEqual([e1]);
  });
});

describe('WeightSync (PROMPTS 155)', () => {
  async function world() {
    const g = new FakeGraphStore();
    await g.upsertGraph({ nodes: ['a', 'b', 'c'].map((n) => node(`file:${n}`)), edges: [edge('file:a', 'file:b')] }, 'v');
    return g;
  }

  it('writes multipliers onto the HydraDB edges, after upserting the learned co_changed edges they belong to', async () => {
    const g = await world();
    const order: string[] = [];
    const upsert = g.upsertGraph.bind(g);
    const set = g.setEdgeWeights.bind(g);
    g.upsertGraph = async (b, v) => (order.push('upsert'), upsert(b, v));
    g.setEdgeWeights = async (u) => (order.push('weights'), set(u));
    const learned = co('file:a', 'file:c');
    const s = new WeightSync(g);
    s.push(doc('w1', { 'file:a|imports|file:b': 1.2, [learned.key]: 1 }, [learned]));
    await s.idle();
    expect(order).toEqual(['upsert', 'weights']);
    expect(g.edges.get('file:a|imports|file:b')?.w).toBe(1.2);
    expect(g.edges.get(learned.key)?.w).toBe(1);
    expect(s.stats).toEqual({ pushes: 1, failures: 0 });
  });

  it('never leaves the weights version in HydraDB\'s graph-version marker (click push compares that marker to know a graph is already there)', async () => {
    const g = await world();
    const versions: string[] = [];
    const upsert = g.upsertGraph.bind(g);
    g.upsertGraph = async (b, v) => (versions.push(v), upsert(b, v));
    const learned = co('file:a', 'file:c');
    // the daemon knows the graph version it holds
    const withProvider = new WeightSync(g, { graphVersion: () => 'graph-1' });
    withProvider.push(doc('weights-1', {}, [learned]));
    await withProvider.idle();
    expect(versions).toEqual(['graph-1']);
    // without a provider the store is asked for what it holds
    versions.length = 0;
    const asked = Object.assign(g, { getIndexVersion: async () => 'graph-2' });
    const viaStore = new WeightSync(asked);
    viaStore.push(doc('weights-2', {}, [co('file:b', 'file:c')]));
    await viaStore.idle();
    expect(versions).toEqual(['graph-2']);
  });

  it('a second document only sends what changed; an older one coming later never overwrites the newer', async () => {
    const g = await world();
    const sent: { key: string; w: number }[][] = [];
    const set = g.setEdgeWeights.bind(g);
    g.setEdgeWeights = async (u) => (sent.push(u), set(u));
    const s = new WeightSync(g);
    s.push(doc('w1', { 'file:a|imports|file:b': 1.2 }));
    await s.idle();
    s.push(doc('w2', { 'file:a|imports|file:b': 1.2, 'file:x|calls|file:y': 0.9 }));
    await s.idle();
    expect(sent).toEqual([[{ key: 'file:a|imports|file:b', w: 1.2 }], [{ key: 'file:x|calls|file:y', w: 0.9 }]]);
  });

  it('documents that arrive while a push is running collapse into one follow-up push to the newest', async () => {
    const g = await world();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let calls = 0;
    const set = g.setEdgeWeights.bind(g);
    g.setEdgeWeights = async (u) => {
      calls++;
      if (calls === 1) await gate;
      return set(u);
    };
    const s = new WeightSync(g);
    s.push(doc('w1', { 'file:a|imports|file:b': 1.1 }));
    await new Promise((r) => setTimeout(r, 10));
    for (let i = 2; i <= 10; i++) s.push(doc(`w${i}`, { 'file:a|imports|file:b': 1 + i / 10 }));
    open();
    await s.idle();
    expect(calls).toBe(2);
    expect(g.edges.get('file:a|imports|file:b')?.w).toBeCloseTo(2, 6);
  });

  it('a failing HydraDB is retried with backoff; push() never throws; the target stays the newest document', async () => {
    const g = await world();
    let fail = 2;
    const set = g.setEdgeWeights.bind(g);
    g.setEdgeWeights = async (u) => {
      if (fail-- > 0) throw new Error('HydraDB down');
      return set(u);
    };
    const s = new WeightSync(g, { retryMs: [10, 10] });
    expect(() => s.push(doc('w1', { 'file:a|imports|file:b': 1.2 }))).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    s.push(doc('w2', { 'file:a|imports|file:b': 1.5 })); // newer while waiting to retry
    await s.idle();
    expect(g.edges.get('file:a|imports|file:b')?.w).toBe(1.5);
    expect(s.stats.failures).toBe(2);
  });

  it('assume() tells it what HydraDB already has, so a restart does not resend everything; close() releases waiters', async () => {
    const g = await world();
    const calls: number[] = [];
    const set = g.setEdgeWeights.bind(g);
    g.setEdgeWeights = async (u) => (calls.push(u.length), set(u));
    const s = new WeightSync(g);
    const d1 = doc('w1', { 'file:a|imports|file:b': 1.2 });
    s.assume(d1);
    s.push(d1);
    await s.idle();
    expect(calls).toEqual([]);
    const failing = new WeightSync(Object.assign(await world(), { setEdgeWeights: () => Promise.reject(new Error('x')) }), { retryMs: [60_000] });
    failing.push(d1);
    const waiting = failing.idle();
    failing.close();
    await waiting;
  });
});
