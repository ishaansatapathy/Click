import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRESETS, resolveConfig, type PresetName } from './config.js';
import { BodyReader } from './graph/bodies.js';
import { GraphHolder } from './graph/holder.js';
import { buildIndex, type BuildResult } from './indexer/build.js';
import { buildLexical, getContext, type Lexical } from './pipeline.js';
import { indexSemanticChunks } from './retrieve/semantic.js';
import { FakeEmbedder, FakeGraphStore, FakeStore } from './testing/fakes.js';
import type { Task } from './types.js';
import { netCounter } from './util/http.js';
import { countTokens } from './util/tokens.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'mini-vue');
const NOW = () => new Date('2026-11-15T10:00:00.000Z');
const temps: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'click-pipeline-'));
  temps.push(d);
  return d;
};
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

let index: BuildResult;
beforeAll(async () => {
  index = await buildIndex(FIXTURE, undefined, { cacheDir: tmp(), now: NOW });
}, 60_000);

async function world(opts: { storeLatency?: number; graphLatency?: number; graphFail?: Error; root?: string; index?: BuildResult } = {}) {
  const idx = opts.index ?? index;
  const store = new FakeStore(opts.storeLatency ? { latencyMs: opts.storeLatency } : {});
  const embedder = new FakeEmbedder();
  await indexSemanticChunks(idx.chunks, idx.graph.version, { store, embedder });
  await store.putConventions(idx.conventions);
  const graph = new FakeGraphStore({ ...(opts.graphLatency ? { latencyMs: opts.graphLatency } : {}), ...(opts.graphFail ? { failWith: opts.graphFail } : {}) });
  await graph.upsertGraph({ nodes: idx.graph.nodes, edges: idx.graph.edges }, idx.graph.version);
  const holder = new GraphHolder<Lexical>(idx.graph, { buildLexical });
  const root = opts.root ?? FIXTURE;
  return { store, embedder, graph, holder, root, bodies: new BodyReader(root) };
}

const task = (text: string, extra: Partial<Task> = {}): Task => ({ text, budgetTokens: 4000, ...extra });
const cfgOf = (name: PresetName, over: Parameters<typeof resolveConfig>[2] = {}) => resolveConfig(null, name, over);
const TEXT = 'submitting the order fails, look at useOrderStore and the checkout button';

describe('getContext (PROMPTS 094)', () => {
  it('V3 end to end: relevant code in the context, within budget, ≤ 2 network calls, no degradation', async () => {
    const w = await world();
    const { result, calls } = await netCounter.run(() => getContext(task(TEXT), cfgOf('V3'), { ...w, now: () => 1000 }));
    const { packed, record } = result;
    expect(calls).toBeLessThanOrEqual(2);
    expect(packed.degraded).toEqual([]);
    expect(packed.tokens).toBeLessThanOrEqual(4000);
    expect(countTokens(packed.text)).toBeLessThanOrEqual(4000);
    expect(packed.text).toContain('useOrderStore');
    expect(packed.text).toContain('<click_context version="1"');
    expect(packed.items.length).toBeGreaterThan(1);
    expect(packed.seeds.length).toBeGreaterThan(0);
    expect(packed.seeds.reduce((s, x) => s + x.score, 0)).toBeCloseTo(1, 6);
    expect(packed.variant).toBe('V3');
    expect(packed.graphVersion).toBe(index.graph.version);
    expect(packed.pruner).toBe('none');
    expect(Object.keys(packed.timings)).toEqual(expect.arrayContaining(['lexical', 'semantic', 'graph', 'ppr', 'pack', 'total']));
    expect(w.graph.calls).toBe(1);
    expect(record).toMatchObject({ v: 1, variant: 'V3', graphVersion: packed.graphVersion, taskText: TEXT, tokens: packed.tokens, degraded: [], source: 'api' });
    expect(record.items).toEqual(packed.items.map((i) => ({ nodeId: i.nodeId, mode: i.mode })));
    expect(record.contextId).toBe(packed.contextId);
  });

  it('identical input gives identical text and ids (pure given a fixed clock)', async () => {
    const w = await world();
    const run = () => getContext(task(TEXT), cfgOf('V3'), { ...w, now: () => 1000, newId: () => 'ctx_fixed' });
    const a = await run();
    const b = await run();
    expect(b.packed.text).toBe(a.packed.text);
    expect(b.record.seeds).toEqual(a.record.seeds);
    expect(b.packed.contextId).toBe('ctx_fixed');
  });

  it('attribution: items reached through the graph record their edge path', async () => {
    const w = await world();
    const { record } = await getContext(task(TEXT), cfgOf('V3'), { ...w });
    const seeded = new Set(record.seeds.map((s) => s.nodeId));
    const reached = record.items.filter((i) => !seeded.has(i.nodeId));
    expect(reached.length).toBeGreaterThan(0);
    for (const [id, keys] of Object.entries(record.attribution)) {
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((k) => k.split('|').length === 3), id).toBe(true);
    }
  });

  it('a slow graph store falls back to the replica within the budget and says so', async () => {
    const w = await world({ graphLatency: 3_000 });
    const t0 = Date.now();
    const { packed } = await getContext(task(TEXT), cfgOf('V3'), { ...w });
    expect(Date.now() - t0).toBeLessThan(1_300);
    expect(packed.degraded).toContain('graph-replica');
    expect(packed.text).toContain('useOrderStore');
    expect(packed.tokens).toBeLessThanOrEqual(4000);
  });

  it('a failing graph store, a missing one, and an empty one (out of sync) all fall back to the replica', async () => {
    const failing = await world({ graphFail: new Error('connection refused') });
    expect((await getContext(task(TEXT), cfgOf('V3'), { ...failing })).packed.degraded).toContain('graph-replica');

    const w = await world();
    const { graph: _graph, ...noGraph } = w;
    const missing = await getContext(task(TEXT), cfgOf('V3'), { ...noGraph });
    expect(missing.packed.degraded).toContain('graph-replica');
    expect(missing.packed.text).toContain('useOrderStore');

    const empty = await world();
    empty.graph.nodes.clear();
    empty.graph.edges.clear();
    expect((await getContext(task(TEXT), cfgOf('V3'), { ...empty })).packed.degraded).toContain('graph-replica');
  });

  it('V3r reads the local replica on purpose: no graph call, not flagged as degraded', async () => {
    const w = await world();
    const { packed } = await getContext(task(TEXT), cfgOf('V3r'), { ...w });
    expect(w.graph.calls).toBe(0);
    expect(packed.degraded).toEqual([]);
    expect(packed.text).toContain('useOrderStore');
  });

  it('hydra and replica graphs give the same top seeds and the same top items on the fixture', async () => {
    const w = await world();
    const a = await getContext(task(TEXT), cfgOf('V3'), { ...w, now: () => 1 });
    const b = await getContext(task(TEXT), cfgOf('V3r'), { ...w, now: () => 1 });
    expect(a.record.seeds).toEqual(b.record.seeds);
    expect(new Set(a.packed.items.slice(0, 3).map((i) => i.nodeId))).toEqual(new Set(b.packed.items.slice(0, 3).map((i) => i.nodeId)));
  });

  it('a semantic store sleeping 2 s degrades to semantic-timeout and the call still returns in < 1300 ms', async () => {
    const w = await world();
    const slow = new FakeStore({ latencyMs: 2_000 });
    const t0 = Date.now();
    const { packed } = await getContext(task(TEXT), cfgOf('V3'), { ...w, store: slow });
    expect(Date.now() - t0).toBeLessThan(1_300);
    expect(packed.degraded).toContain('semantic-timeout');
    expect(packed.text).toContain('useOrderStore'); // symbol + BM25 seeds carried it
    expect(packed.text).toContain('degraded="semantic-timeout');
  });

  it('a failing semantic store reports semantic-error; a missing embedder reports semantic-off', async () => {
    const w = await world();
    const broken = new FakeStore({ failWith: new Error('boom') });
    expect((await getContext(task(TEXT), cfgOf('V3'), { ...w, store: broken })).packed.degraded).toContain('semantic-error');
    const { embedder: _e, ...noEmbedder } = w;
    expect((await getContext(task(TEXT), cfgOf('V3'), { ...noEmbedder })).packed.degraded).toContain('semantic-off');
  });

  it('V2 (no graph) never touches the graph store; V1 packs chunks', async () => {
    const w = await world();
    const v2 = await getContext(task(TEXT), cfgOf('V2'), { ...w });
    expect(w.graph.calls).toBe(0);
    expect(v2.packed.items.length).toBeGreaterThan(0);
    expect(v2.packed.items.every((i) => i.mode !== 'ref')).toBe(true);

    const v1 = await getContext(task(TEXT), cfgOf('V1'), { ...w });
    expect(v1.packed.items.length).toBeGreaterThan(0);
    expect(v1.packed.items.every((i) => i.nodeId.startsWith('chunk:'))).toBe(true);
    expect(v1.packed.tokens).toBeLessThanOrEqual(4000);
  });

  it('respects a small budget', async () => {
    const w = await world();
    for (const budget of [500, 800, 1500]) {
      const { packed } = await getContext(task(TEXT, { budgetTokens: budget }), cfgOf('V3'), { ...w });
      expect(countTokens(packed.text), `budget ${budget}`).toBeLessThanOrEqual(budget);
      expect(packed.budget).toBe(budget);
    }
  });

  it('no snapshot and no holder: warming, an empty context, no throw', async () => {
    const w = await world({ root: tmp() });
    const { holder: _h, ...rest } = w;
    const { packed, record } = await getContext(task(TEXT), cfgOf('V3'), { ...rest });
    expect(packed.degraded).toEqual(['warming']);
    expect(packed.text).toBe('');
    expect(record.items).toEqual([]);
  });

  it('loads the snapshot under <root>/.click/graph when no holder is given', async () => {
    const { SnapshotStore } = await import('./graph/snapshot.js');
    const root = tmp();
    const snaps = new SnapshotStore(join(root, '.click', 'graph'));
    await snaps.write(index.graph, { profileHash: 'p' });
    cpSync(join(FIXTURE, 'src'), join(root, 'src'), { recursive: true });
    const w = await world({ root });
    const { holder: _h, ...rest } = w;
    const { packed } = await getContext(task(TEXT), cfgOf('V3r'), { ...rest });
    expect(packed.degraded).toEqual([]);
    expect(packed.text).toContain('useOrderStore');
  });

  it('a file edited after indexing is served as a signature and flagged stale-body (also in the header)', async () => {
    const root = tmp();
    cpSync(FIXTURE, root, { recursive: true, filter: (s) => !s.includes('.click') });
    mkdirSync(join(root, '.click'), { recursive: true });
    const idx = await buildIndex(root, undefined, { cacheDir: tmp(), now: NOW });
    appendFileSync(join(root, 'src', 'stores', 'order.ts'), '\n// edited after indexing\n');
    const w = await world({ root, index: idx });
    const { packed } = await getContext(task(TEXT), cfgOf('V3'), { ...w });
    expect(packed.degraded).toContain('stale-body');
    expect(packed.text).toContain('degraded="stale-body"');
    const store = packed.items.find((i) => i.path === 'src/stores/order.ts');
    expect(store?.mode).toBe('signature');
    expect(packed.text).not.toContain('// edited after indexing');
  });

  it('delivery preset adds conventions and the skeleton prefix; V3 does not', async () => {
    const w = await world();
    const d = await getContext(task(TEXT), cfgOf('delivery'), { ...w });
    expect(d.packed.text).toContain('## Conventions');
    expect(d.packed.text).toContain('## Skeleton');
    expect(d.packed.tokens).toBeLessThanOrEqual(4000);
    const v3 = await getContext(task(TEXT), cfgOf('V3'), { ...w });
    expect(v3.packed.text).not.toContain('## Skeleton');
  });

  it('session dedupe: nodes already sent become refs', async () => {
    const w = await world();
    const first = await getContext(task(TEXT), cfgOf('delivery'), { ...w });
    const sent = new Set(first.packed.items.filter((i) => i.mode === 'body').map((i) => i.nodeId));
    const again = await getContext(task(TEXT, { sessionId: 's1' }), cfgOf('delivery'), { ...w, sent: (id) => (id === 's1' ? sent : undefined) });
    expect(again.packed.items.some((i) => i.mode === 'ref')).toBe(true);
    expect(again.packed.text).toContain('## Already sent this session');
    expect(again.record.sessionId).toBe('s1');
  });

  it('open files become seeds labelled open-file', async () => {
    const w = await world();
    const { packed } = await getContext(task('tidy things up', { openFiles: ['src/stores/cart.ts'] }), cfgOf('V3'), { ...w });
    expect(packed.seeds.find((s) => s.sources.includes('open-file'))?.nodeId).toBe('file:src/stores/cart.ts');
  });

  it('an empty task still answers (no seeds, empty context)', async () => {
    const w = await world();
    const { packed } = await getContext(task(''), cfgOf('V3'), { ...w });
    expect(packed.seeds).toEqual([]);
    expect(packed.tokens).toBeLessThanOrEqual(4000);
  });

  it('uses the preset config hash and variant id', () => {
    expect(PRESETS.V3.id).toBe('V3');
  });
});
