import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuildResult } from '../../../core/src/indexer/build.js';
import { buildLexical } from '../../../core/src/pipeline.js';
import { FakeGraphStore } from '../../../core/src/testing/fakes.js';
import type { Convention, PackedContext } from '../../../core/src/types.js';
import { computeImpact, replicaImpact, resolveSymbol, type ImpactItem } from './impact.js';
import { StatsKeeper } from './stats.js';
import { cleanupTemps, reference, startWorld, type World } from './testkit.js';

let ref: BuildResult;
let lexical: ReturnType<typeof buildLexical>;
beforeAll(async () => {
  ref = await reference();
  lexical = buildLexical(ref.graph);
}, 60_000);
afterAll(cleanupTemps);

const STORE = 'sym:src/stores/order.ts#useOrderStore';
const names = (g: Awaited<ReturnType<typeof computeImpact>>['groups']) => Object.fromEntries((Object.entries(g) as [string, ImpactItem[]][]).map(([k, v]) => [k, v.map((i) => i.name).sort()]));
async function hydra(): Promise<FakeGraphStore> {
  const g = new FakeGraphStore();
  await g.upsertGraph({ nodes: ref.graph.nodes, edges: ref.graph.edges }, 'v');
  return g;
}

describe('resolveSymbol (PROMPTS 171)', () => {
  it('node id, exact name, name ignoring case, file path, then the best lexical match', () => {
    expect(resolveSymbol(STORE, ref.graph, lexical)?.id).toBe(STORE);
    expect(resolveSymbol('useOrderStore', ref.graph, lexical)?.id).toBe(STORE);
    expect(resolveSymbol('USEORDERSTORE', ref.graph, lexical)?.id).toBe(STORE);
    expect(resolveSymbol('src/stores/order.ts', ref.graph, lexical)?.kind).toBe('file');
    expect(resolveSymbol('order store', ref.graph, lexical)?.name).toBe('useOrderStore');
    expect(resolveSymbol('', ref.graph, lexical)).toBeNull();
    expect(resolveSymbol('zzzqqqxxx', ref.graph, lexical)).toBeNull();
  });
  it('a name shared by several nodes prefers the stores and components over files and tests', () => {
    const graph = { nodes: [
      { id: 'file:a.ts', kind: 'file' as const, path: 'a.ts', name: 'thing', tokens: 1, sigTokens: 0, fileHash: 'h' },
      { id: 'sym:a.ts#thing', kind: 'store' as const, path: 'a.ts', name: 'thing', tokens: 1, sigTokens: 0, fileHash: 'h' },
    ] };
    expect(resolveSymbol('thing', graph, null)?.kind).toBe('store');
  });
});

describe('computeImpact: what breaks if I change useOrderStore (PROMPTS 171)', () => {
  it('on the replica: the components that use it, the routes that render them, and the test, each with its edge chain', async () => {
    const r = await computeImpact('useOrderStore', 3, { graph: ref.graph, lexical, store: null });
    expect(r).toMatchObject({ symbol: 'useOrderStore', depth: 3, source: 'replica', count: 6 });
    expect(r.resolved).toMatchObject({ nodeId: STORE, name: 'useOrderStore', path: 'src/stores/order.ts', kind: 'store' });
    expect(names(r.groups)).toEqual({
      components: ['CheckoutButton', 'CheckoutView', 'OrderDetailView'],
      stores: [], composables: [],
      routes: ['checkout', 'order-detail'],
      tests: ['checkout.spec.ts'],
      other: [],
    });
    const button = r.groups.components.find((i) => i.name === 'CheckoutButton')!;
    expect(button).toMatchObject({ distance: 1, path: 'src/components/CheckoutButton.vue', kind: 'component' });
    expect(button.chain).toEqual([`sym:src/components/CheckoutButton.vue#CheckoutButton|uses_store|${STORE}`]);
    const route = r.groups.routes.find((i) => i.name === 'checkout')!;
    expect(route.distance).toBe(2);
    expect(route.chain).toHaveLength(2);
    expect(route.chain[0]).toContain('|routes_to|'); // route -> view -> store: the chain is read from the item down to the symbol
    expect(route.chain[1]).toContain(`|uses_store|${STORE}`);
    const test = r.groups.tests[0]!;
    expect(test.chain[0]).toContain('|tested_by|');
    // every chain of code is connected: each edge's target is the next edge's source, and the last one ends at the symbol
    for (const i of (Object.values(r.groups) as ImpactItem[][]).flat().filter((x) => x.kind !== 'test')) {
      const edges = i.chain.map((k) => k.split('|') as [string, string, string]);
      expect(edges.at(-1)?.[2], i.name).toBe(STORE);
      for (let k = 0; k < edges.length - 1; k++) expect(edges[k]![2]).toBe(edges[k + 1]![0]);
    }
  });

  it('through HydraDB it finds the same nodes, and says so', async () => {
    const viaHydra = await computeImpact('useOrderStore', 3, { graph: ref.graph, lexical, store: await hydra() });
    const viaReplica = await computeImpact('useOrderStore', 3, { graph: ref.graph, lexical, store: null });
    expect(viaHydra.source).toBe('hydra');
    expect(names(viaHydra.groups)).toEqual(names(viaReplica.groups));
    expect(viaHydra.groups.routes.map((i) => i.distance).sort()).toEqual(viaReplica.groups.routes.map((i) => i.distance).sort());
  });

  it('falls back to the replica when HydraDB fails, is too slow, or knows nothing', async () => {
    const down = new FakeGraphStore({ failWith: new Error('connection refused') });
    expect((await computeImpact('useOrderStore', 3, { graph: ref.graph, lexical, store: down })).source).toBe('replica');
    const slow = await hydra();
    const t0 = Date.now();
    const s = await computeImpact('useOrderStore', 3, { graph: ref.graph, lexical, store: new FakeGraphStore({ latencyMs: 3_000 }), timeoutMs: 60 });
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(s).toMatchObject({ source: 'replica', count: 6 });
    void slow;
    const empty = await computeImpact('useOrderStore', 3, { graph: ref.graph, lexical, store: new FakeGraphStore() }); // HydraDB holds no graph
    expect(empty).toMatchObject({ source: 'replica', count: 6 });
  });

  it('depth limits the walk (and is clamped to 1..3); nearer dependents come first', async () => {
    const one = await computeImpact('useOrderStore', 1, { graph: ref.graph, lexical, store: null });
    expect(Object.values(one.groups).flat().every((i) => i.distance === 1)).toBe(true);
    expect(names(one.groups).routes).toEqual([]);
    expect((await computeImpact('useOrderStore', 0, { graph: ref.graph, lexical, store: null })).depth).toBe(1);
    expect((await computeImpact('useOrderStore', 99, { graph: ref.graph, lexical, store: null })).depth).toBe(3);
    const all = Object.values((await computeImpact('useOrderStore', 3, { graph: ref.graph, lexical, store: null })).groups).flat();
    expect(all.length).toBe(6);
    const comps = (await computeImpact('useOrderStore', 3, { graph: ref.graph, lexical, store: null })).groups.components;
    expect(comps.map((c) => c.distance)).toEqual([...comps.map((c) => c.distance)].sort());
  });

  it('an unknown name resolves to nothing, with an empty answer; a leaf nothing depends on has no impact', async () => {
    const none = await computeImpact('nonexistentthing', 3, { graph: ref.graph, lexical, store: null });
    expect(none).toMatchObject({ resolved: null, count: 0, source: null });
    const leaf = await computeImpact('sym:src/main.ts#nothing', 3, { graph: ref.graph, lexical, store: null });
    expect(leaf.count).toBe(0);
  });

  it('a file that merely imports the symbol is folded into the component inside it (no duplicates)', async () => {
    const r = await computeImpact('useSubmit', 3, { graph: ref.graph, lexical, store: null });
    const all = Object.values(r.groups).flat();
    for (const i of all.filter((x) => x.kind === 'file')) expect(all.some((o) => o.kind !== 'file' && o.path === i.path), i.path ?? '').toBe(false);
    expect(new Set(all.map((i) => i.nodeId)).size).toBe(all.length);
  });

  it('replicaImpact is breadth-first and deterministic', () => {
    const a = replicaImpact(ref.graph, STORE, 3);
    expect(JSON.stringify(replicaImpact(ref.graph, STORE, 3))).toBe(JSON.stringify(a));
    expect(a.map((f) => f.chain.length)).toEqual([...a.map((f) => f.chain.length)].sort());
  });
});

describe('GET /impact and GET /conventions on a running daemon (PROMPTS 171, 172)', () => {
  const worlds: World[] = [];
  afterAll(async () => {
    await Promise.all(worlds.map((w) => w.close()));
  });
  const world = async (o: Partial<Parameters<typeof startWorld>[0]> = {}): Promise<World> => {
    const w = await startWorld({ ref, ...o });
    worlds.push(w);
    return w;
  };

  it('answers "what breaks if I change useOrderStore" over HTTP', async () => {
    const w = await world();
    const r = await w.json<{ ok: boolean; resolved: { name: string }; count: number; source: string; groups: Record<string, { name: string; chain: string[] }[]> }>('/impact?symbol=useOrderStore&depth=3');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, resolved: { name: 'useOrderStore' }, count: 6, source: 'hydra' });
    expect(r.body.groups.components!.map((i) => i.name).sort()).toEqual(['CheckoutButton', 'CheckoutView', 'OrderDetailView']);
    expect(r.body.groups.routes!.every((i) => i.chain.length >= 1)).toBe(true);
    const fuzzy = await w.json<{ resolved: { name: string } }>('/impact?symbol=order%20store');
    expect(fuzzy.body.resolved.name).toBe('useOrderStore');
  }, 60_000);

  it('validates its query; an unknown symbol is a normal empty answer; while warming it says so', async () => {
    const w = await world();
    expect((await w.json('/impact')).status).toBe(400);
    expect((await w.json('/impact?symbol=x&depth=9')).status).toBe(400);
    expect((await w.json('/impact?symbol=x&depth=abc')).status).toBe(400);
    expect(await w.json('/impact?symbol=zzzqqqxxx')).toMatchObject({ status: 200, body: { resolved: null, count: 0 } });
    expect((await w.call('/impact?symbol=x', {}, null)).status).toBe(401);
    const cold = await world({ waitReady: false, seedGraph: false, config: { build: () => new Promise(() => undefined) } });
    expect(await cold.json('/impact?symbol=useOrderStore')).toMatchObject({ status: 200, body: { status: 'warming', count: 0 } });
  }, 60_000);

  it('/conventions lists the conventions that are current now, oldest first, with their start date', async () => {
    const w = await world();
    const items: Convention[] = [
      { id: 'conv:b', text: 'Use pinia setup stores', source: 'x', validFrom: '2026-03-01', validTo: null },
      { id: 'conv:old', text: 'Options API', source: 'x', validFrom: '2025-01-01', validTo: '2026-02-01' },
      { id: 'conv:a', text: 'Use script setup', source: 'x', validFrom: '2026-01-15', validTo: null },
    ];
    await w.store.putConventions(items);
    const r = await w.json<{ items: Convention[] }>('/conventions');
    expect(r.status).toBe(200);
    expect(r.body.items.map((c) => c.id)).toEqual(['conv:a', 'conv:b']);
    expect(r.body.items.every((c) => c.validTo === null && c.validFrom)).toBe(true);
  }, 60_000);

  it('a /context for the same repo still works next to the new routes (no interference)', async () => {
    const w = await world();
    const c = await w.json<PackedContext>('/context', { task: 'what uses useOrderStore in checkout', variant: 'V3' });
    expect(c.status).toBe(200);
    expect(c.body.text).toContain('useOrderStore');
  }, 60_000);
});

describe('stats.json is written at most once per second (PROMPTS 176)', () => {
  const packed = (n: number): PackedContext => ({ contextId: `c${n}`, text: '', tokens: 100, budget: 4000, items: [], seeds: [], variant: 'V3', configHash: 'h', pruner: 'none', graphVersion: 'g', weightsVersion: null, timings: {}, degraded: [] });
  const totals = (file: string): number => (JSON.parse(readFileSync(file, 'utf8')) as { totals: { contexts: number } }).totals.contexts;

  it('the first context is written at once; a burst after it waits and lands as one write with the newest numbers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'click-stats-'));
    try {
      let t = 10_000;
      const k = new StatsKeeper(dir, undefined, () => t);
      const file = join(dir, 'stats.json');
      k.record(packed(1), 's', 5);
      await new Promise((r) => setTimeout(r, 50));
      expect(totals(file)).toBe(1);
      for (let i = 2; i <= 20; i++) k.record(packed(i), 's', 5);
      await new Promise((r) => setTimeout(r, 50));
      expect(totals(file)).toBe(1); // throttled: the burst is not on disk yet
      expect(k.get().totals.contexts).toBe(20); // but memory (what /stats serves) is current
      await k.flush();
      expect(totals(file)).toBe(20);
      t += 5_000; // a quiet period later the next context is written at once again
      k.record(packed(21), 's', 5);
      await new Promise((r) => setTimeout(r, 50));
      expect(totals(file)).toBe(21);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
