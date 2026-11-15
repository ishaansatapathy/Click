import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SnapshotStore } from '../../../core/src/graph/snapshot.js';
import { buildIndex, type BuildResult } from '../../../core/src/indexer/build.js';
import { FakeEmbedder, FakeGraphStore, FakeStore } from '../../../core/src/testing/fakes.js';
import type { GraphStore } from '../../../core/src/store/types.js';
import { createLogger } from '../../../core/src/util/log.js';
import { boot, BOOT_BUDGET_MS, DaemonState } from './boot.js';
import { GraphSync } from './graphsync.js';
import { Persister } from './persist.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'core', 'test', 'fixtures', 'mini-vue');
const temps: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'click-boot-'));
  temps.push(d);
  return d;
};
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

let reference: BuildResult;
beforeAll(async () => {
  reference = await buildIndex(FIXTURE, undefined, { cacheDir: tmp(), now: () => new Date('2026-11-15T10:00:00.000Z') });
}, 60_000);

/** A repo copy with a clean .click, and the dependencies a daemon would be given. */
function setup(opts: { graph?: GraphStore | null; embedder?: boolean } = {}) {
  const root = tmp();
  cpSync(FIXTURE, root, { recursive: true, filter: (s) => !s.includes('.click') });
  const store = new FakeStore();
  const graph = opts.graph === undefined ? new FakeGraphStore() : opts.graph;
  const log = createLogger('test', { dir: join(root, 'logs'), env: {} });
  const sync = graph ? new GraphSync(graph, { log }) : null;
  const persist = new Persister({ root, store, sync, log, ...(opts.embedder ? { embedder: new FakeEmbedder() } : {}) });
  return { root, store, graph, sync, persist, log, deps: { root, store, graph, persist, log } };
}

describe('boot (PROMPTS 111)', () => {
  it('no snapshot and nothing in HydraDB: indexes the repo, saves it locally and pushes it to HydraDB in the background', async () => {
    const s = setup();
    const b = await boot(s.deps);
    expect(b.source).toBe('index');
    expect(b.indexState).not.toBeNull();
    expect(b.holder.current().graph.version).toBe(reference.graph.version);
    expect(b.ms).toHaveProperty('index');
    expect(b.ms.total).toBeGreaterThan(0);

    const snap = await new SnapshotStore(join(s.root, '.click', 'graph')).load();
    expect(snap.ok && snap.graph.version).toBe(reference.graph.version);
    expect(s.store.chunks.size).toBe(reference.chunks.length);
    expect((await s.store.getConventions()).length).toBe(reference.conventions.length);
    await s.sync!.idle();
    const g = s.graph as FakeGraphStore;
    expect(g.nodes.size).toBe(reference.graph.nodes.length);
    expect(g.edges.size).toBe(reference.graph.edges.length);
  }, 60_000);

  it('with a snapshot on disk it loads it, without indexing and without asking HydraDB', async () => {
    const s = setup();
    await boot(s.deps); // first boot writes the snapshot
    let loadAllCalls = 0;
    const spy = s.graph as FakeGraphStore;
    const orig = spy.loadAll.bind(spy);
    spy.loadAll = () => (loadAllCalls++, orig());
    const second = await boot({ ...s.deps, build: () => Promise.reject(new Error('must not index')) });
    expect(second.source).toBe('snapshot');
    expect(second.indexState).toBeNull();
    expect(loadAllCalls).toBe(0);
    expect(second.holder.current().graph.nodes.length).toBe(reference.graph.nodes.length);
    expect(second.ms.total).toBeLessThan(BOOT_BUDGET_MS);
  }, 60_000);

  it('boots the weights doc from the store into the holder', async () => {
    const s = setup();
    await s.store.putWeights({ v: 1, version: 'w1', derivedFrom: null, events: 3, params: { alpha: 0.2, beta: 0.1, min: 0.1, max: 5 }, multipliers: {}, addedEdges: [] });
    const b = await boot(s.deps);
    expect(b.holder.current().weightsVersion).toBe('w1');
  }, 60_000);

  it('no snapshot but HydraDB holds the graph: pulls it (and chunk records from the local store), saves a snapshot, never indexes', async () => {
    const s = setup();
    const g = s.graph as FakeGraphStore;
    await g.upsertGraph({ nodes: reference.graph.nodes, edges: reference.graph.edges }, reference.graph.version);
    await s.store.upsert({ chunks: reference.chunks }, reference.graph.version);
    const b = await boot({ ...s.deps, build: () => Promise.reject(new Error('must not index')) });
    expect(b.source).toBe('hydra');
    expect(b.holder.current().graph.version).toBe(reference.graph.version); // same content, same version hash
    expect(b.holder.current().graph.chunks.length).toBe(reference.chunks.length);
    expect(b.holder.current().graph.chunks.every((c) => !('text' in c))).toBe(true);
    expect((await new SnapshotStore(join(s.root, '.click', 'graph')).load()).ok).toBe(true);
  }, 60_000);

  it('HydraDB failing or slow never stops a boot: it falls through to indexing', async () => {
    const failing = setup({ graph: new FakeGraphStore() });
    const fg = failing.graph as FakeGraphStore;
    fg.loadAll = () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('connection refused')) }) });
    expect((await boot(failing.deps)).source).toBe('index');

    const slow = setup({ graph: new FakeGraphStore() });
    const sg = slow.graph as FakeGraphStore;
    sg.loadAll = () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) });
    const t0 = Date.now();
    expect((await boot({ ...slow.deps, hydraLoadTimeoutMs: 50 })).source).toBe('index');
    expect(Date.now() - t0).toBeLessThan(20_000);
  }, 90_000);

  it('works with no HydraDB configured at all', async () => {
    const s = setup({ graph: null });
    expect((await boot(s.deps)).source).toBe('index');
  }, 60_000);

  it('a corrupt snapshot is ignored (and replaced)', async () => {
    const s = setup();
    mkdirSync(join(s.root, '.click', 'graph'), { recursive: true });
    writeFileSync(join(s.root, '.click', 'graph', 'broken.json.gz'), 'not gzip');
    writeFileSync(join(s.root, '.click', 'graph', 'CURRENT'), 'broken');
    const b = await boot(s.deps);
    expect(b.source).toBe('index');
    const snap = await new SnapshotStore(join(s.root, '.click', 'graph')).load();
    expect(snap.ok).toBe(true);
  }, 60_000);

  it('embeds chunks in the background when an embedder is configured', async () => {
    const s = setup({ embedder: true });
    await boot(s.deps);
    await s.persist.settled();
    expect([...s.store.chunks.values()].every((c) => (c.vector?.length ?? 0) > 0)).toBe(true);
  }, 60_000);
});

describe('DaemonState.hydraHealth (PROMPTS 111)', () => {
  it('reports ok / not ok / not configured, and caches for a few seconds', async () => {
    let calls = 0;
    const g = { health: async () => (calls++, { ok: true, version: '0.4.0' }) } as unknown as GraphStore;
    let t = 1_000;
    const st = new DaemonState(g, () => t);
    expect(await st.hydraHealth()).toMatchObject({ ok: true, version: '0.4.0' });
    await st.hydraHealth();
    expect(calls).toBe(1);
    t += 6_000;
    await st.hydraHealth();
    expect(calls).toBe(2);

    expect(await new DaemonState(null).hydraHealth()).toMatchObject({ ok: false, detail: 'not configured' });
    const down = { health: async () => Promise.reject(new Error('refused')) } as unknown as GraphStore;
    expect(await new DaemonState(down).hydraHealth()).toMatchObject({ ok: false, detail: 'refused' });
  });

  it('a hung health check is cut off after 300 ms', async () => {
    const hung = { health: () => new Promise(() => undefined) } as unknown as GraphStore;
    const t0 = Date.now();
    expect(await new DaemonState(hung).hydraHealth()).toMatchObject({ ok: false, detail: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe('warmGraphStore', () => {
  it('sends one throwaway neighbourhood query, and never throws or waits', async () => {
    const { warmGraphStore } = await import('./daemon.js');
    const g = new FakeGraphStore();
    warmGraphStore(g, 'file:a.ts');
    expect(g.calls).toBe(1);
    warmGraphStore(null, 'x');
    warmGraphStore(g, undefined);
    expect(g.calls).toBe(1);
    const failing = new FakeGraphStore({ failWith: new Error('down') });
    expect(() => warmGraphStore(failing, 'x')).not.toThrow();
    await new Promise((r) => setTimeout(r, 20)); // the rejection is swallowed, not unhandled
  });
});
