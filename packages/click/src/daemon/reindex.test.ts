import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnapshotStore } from '../../../core/src/graph/snapshot.js';
import type { BuildResult } from '../../../core/src/indexer/build.js';
import type { PackedContext } from '../../../core/src/types.js';
import { ReindexQueue, type ReindexJob } from './reindex.js';
import { cleanupTemps, reference, startWorld, type World } from './testkit.js';

describe('ReindexQueue (PROMPTS 113)', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  const make = (run: (j: ReindexJob) => Promise<void>, o: { debounceMs?: number; maxWaitMs?: number; maxAttempts?: number } = {}) => new ReindexQueue({ run, ...o });

  it('a burst of 10 calls runs one re-index, with the union of the paths', async () => {
    const jobs: ReindexJob[] = [];
    const q = make(async (j) => void jobs.push(j));
    for (let i = 0; i < 10; i++) {
      q.enqueue({ paths: [`src/f${i % 7}.ts`] });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(jobs).toHaveLength(0); // still inside the debounce window
    await vi.advanceTimersByTimeAsync(2_000);
    expect(jobs).toHaveLength(1);
    expect([...jobs[0]!.paths].sort()).toEqual(['src/f0.ts', 'src/f1.ts', 'src/f2.ts', 'src/f3.ts', 'src/f4.ts', 'src/f5.ts', 'src/f6.ts']);
    expect(q.stats).toMatchObject({ enqueued: 10, runs: 1 });
    await q.idle();
  });

  it('each call restarts the 2 s debounce; a steady stream still runs at maxWait', async () => {
    const runs: number[] = [];
    const q = make(async () => void runs.push(Date.now()), { debounceMs: 2_000, maxWaitMs: 5_000 });
    const t0 = Date.now();
    for (let i = 0; i < 8; i++) {
      q.enqueue({ paths: ['a.ts'] });
      await vi.advanceTimersByTimeAsync(1_500); // never quiet for 2 s
    }
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0]! - t0).toBeLessThanOrEqual(5_100);
    await vi.advanceTimersByTimeAsync(3_000);
    await q.idle();
  });

  it('single flight: a call that arrives during a run waits and becomes one follow-up run; runs never overlap', async () => {
    let release!: () => void;
    let concurrent = 0;
    let peak = 0;
    const jobs: ReindexJob[] = [];
    const q = make(async (j) => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      jobs.push(j);
      if (jobs.length === 1) await new Promise<void>((r) => (release = r));
      concurrent--;
    });
    q.enqueue({ paths: ['a.ts'] });
    await vi.advanceTimersByTimeAsync(2_100);
    expect(jobs).toHaveLength(1);
    for (const p of ['b.ts', 'c.ts', 'd.ts']) q.enqueue({ paths: [p] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(jobs).toHaveLength(1); // the first run is still going
    release();
    await vi.advanceTimersByTimeAsync(2_100);
    expect(jobs).toHaveLength(2);
    expect([...jobs[1]!.paths].sort()).toEqual(['b.ts', 'c.ts', 'd.ts']);
    expect(peak).toBe(1);
    await q.idle();
  });

  it('no paths means "detect what changed"; full wins; both are remembered across coalescing', async () => {
    const jobs: ReindexJob[] = [];
    const q = make(async (j) => void jobs.push(j));
    q.enqueue({});
    q.enqueue({ paths: ['a.ts'] });
    q.enqueue({ full: true });
    await vi.advanceTimersByTimeAsync(2_100);
    expect(jobs).toEqual([{ paths: new Set(['a.ts']), detect: true, full: true }]);
  });

  it('flush() runs what is waiting at once; idle() resolves when there is nothing left', async () => {
    const jobs: ReindexJob[] = [];
    const q = make(async (j) => void jobs.push(j));
    await q.idle(); // nothing queued: immediate
    q.enqueue({ paths: ['a.ts'] });
    expect(q.busy).toBe(true);
    await q.flush();
    expect(jobs).toHaveLength(1);
    expect(q.busy).toBe(false);
  });

  it('a failing run is retried with its paths intact, then dropped after maxAttempts; the queue keeps working', async () => {
    let attempts = 0;
    const seen: string[][] = [];
    const q = make(
      async (j) => {
        attempts++;
        seen.push([...j.paths]);
        throw new Error('index exploded');
      },
      { maxAttempts: 3 },
    );
    q.enqueue({ paths: ['a.ts'] });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(attempts).toBe(3);
    expect(seen).toEqual([['a.ts'], ['a.ts'], ['a.ts']]);
    expect(q.busy).toBe(false);
    q.enqueue({ paths: ['b.ts'] }); // later changes are not poisoned by the earlier failure
    await vi.advanceTimersByTimeAsync(2_100);
    expect(seen.at(-1)).toEqual(['b.ts']);
    q.close();
  });

  it('close() drops what is waiting and releases idle() waiters', async () => {
    const jobs: ReindexJob[] = [];
    const q = make(async (j) => void jobs.push(j));
    q.enqueue({ paths: ['a.ts'] });
    const waiting = q.idle();
    q.close();
    await waiting;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(jobs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- the whole thing

let ref: BuildResult;
beforeAll(async () => {
  ref = await reference();
}, 60_000);
afterAll(cleanupTemps);

const worlds: World[] = [];
const world = async (o: Partial<Parameters<typeof startWorld>[0]> = {}): Promise<World> => {
  const w = await startWorld({ ref, seedGraph: false, ...o }); // empty HydraDB → boot indexes, so incremental updates are available
  worlds.push(w);
  return w;
};
afterAll(async () => {
  await Promise.all(worlds.map((w) => w.close()));
});

const waitFor = async (check: () => Promise<boolean> | boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not reached in time');
};
const graphVersion = async (w: World): Promise<string> => ((await w.json<{ graphVersion: string }>('/health')).body.graphVersion);

describe('POST /reindex end to end (PROMPTS 113)', () => {
  const FILE = 'src/composables/useFormat.ts';
  const ADDED = '\nexport function formatWidgetSerial(n: number): string {\n  return `W-${n}`;\n}\n';

  it('an edited file is picked up: new graph swapped in, snapshot saved, delta pushed to HydraDB, new code retrievable', async () => {
    const w = await world();
    const v0 = await graphVersion(w);
    expect(v0).toBe(ref.graph.version);

    appendFileSync(join(w.root, FILE), ADDED);
    const r = await w.json<{ ok: boolean; queued: number }>('/reindex', { paths: [FILE] });
    expect(r).toMatchObject({ status: 200, body: { ok: true, queued: 1 } });
    await waitFor(async () => (await graphVersion(w)) !== v0);
    await w.daemon.settled();

    const v1 = await graphVersion(w);
    expect(v1).not.toBe(v0);
    expect(w.daemon.state.holder!.current().graph.nodes.some((n) => n.name === 'formatWidgetSerial')).toBe(true);
    expect((await new SnapshotStore(join(w.root, '.click', 'graph')).currentVersion())).toBe(v1);
    expect([...w.graph.nodes.values()].some((n) => n.name === 'formatWidgetSerial')).toBe(true); // pushed in the background
    expect([...w.store.nodes.values()].some((n) => n.name === 'formatWidgetSerial')).toBe(true);

    const ctx = await w.json<PackedContext>('/context', { task: 'change formatWidgetSerial so the serial is padded' });
    expect(ctx.body.text).toContain('formatWidgetSerial');
    expect(ctx.body.text).toContain('W-${n}'); // the body is the code on disk right now
    expect(ctx.body.graphVersion).toBe(v1);
    expect(w.daemon.queue.stats.runs).toBe(1);
  }, 60_000);

  it('a burst of 10 /reindex calls runs exactly one re-index', async () => {
    const w = await world({ config: { debounceMs: 150 } });
    appendFileSync(join(w.root, FILE), ADDED);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => w.json('/reindex', { paths: [i % 2 ? FILE : 'src/stores/cart.ts'] })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    await w.daemon.queue.idle();
    expect(w.daemon.queue.stats.enqueued).toBe(10);
    expect(w.daemon.queue.stats.runs).toBe(1);
    expect(w.daemon.queue.stats.maxConcurrent).toBe(1);
  }, 60_000);

  it('a deleted file disappears from the graph and from HydraDB', async () => {
    const w = await world();
    const path = 'src/composables/useFormat.ts';
    const before = w.daemon.state.holder!.current().graph.nodes.filter((n) => n.path === path).map((n) => n.id);
    expect(before.length).toBeGreaterThan(0);
    rmSync(join(w.root, path));
    await w.json('/reindex', { paths: [path] });
    await w.daemon.queue.flush();
    await w.daemon.settled();
    const ids = new Set(w.daemon.state.holder!.current().graph.nodes.map((n) => n.id));
    for (const id of before) {
      expect(ids.has(id), id).toBe(false);
      expect(w.graph.nodes.has(id), id).toBe(false);
    }
  }, 60_000);

  it('a re-index that changes nothing keeps the graph version and writes nothing new', async () => {
    const w = await world();
    const v0 = await graphVersion(w);
    writeFileSync(join(w.root, FILE), readFileSync(join(w.root, FILE), 'utf8')); // same bytes
    await w.json('/reindex', { paths: [FILE] });
    await w.daemon.queue.flush();
    expect(await graphVersion(w)).toBe(v0);
  }, 60_000);

  it('full: true rebuilds from scratch', async () => {
    const w = await world();
    appendFileSync(join(w.root, FILE), ADDED);
    await w.json('/reindex', { full: true });
    await w.daemon.queue.flush();
    expect(w.daemon.state.holder!.current().graph.nodes.some((n) => n.name === 'formatWidgetSerial')).toBe(true);
  }, 60_000);

  it('a hung or failing HydraDB never blocks a re-index; the replica stays correct and the push is retried', async () => {
    const w = await world();
    let failing = true;
    const up = w.graph.upsertGraph.bind(w.graph);
    w.graph.upsertGraph = async (b, v) => {
      if (failing) throw new Error('HydraDB is down');
      return up(b, v);
    };
    appendFileSync(join(w.root, FILE), ADDED);
    const v0 = await graphVersion(w);
    await w.json('/reindex', { paths: [FILE] });
    await waitFor(async () => (await graphVersion(w)) !== v0); // local graph is already current
    await w.daemon.queue.idle(); // the swap happens first; wait until the run has also saved and queued its HydraDB push
    expect(w.daemon.state.holder!.current().graph.nodes.some((n) => n.name === 'formatWidgetSerial')).toBe(true);
    expect([...w.graph.nodes.values()].some((n) => n.name === 'formatWidgetSerial')).toBe(false);
    expect((await w.json<PackedContext>('/context', { task: 'formatWidgetSerial' })).body.text).toContain('formatWidgetSerial');
    expect(w.daemon.sync!.busy).toBe(true); // queued for retry
    failing = false;
  }, 60_000);

  it('a re-index finishes in well under 2 s for a one-file change', async () => {
    const w = await world();
    appendFileSync(join(w.root, FILE), ADDED);
    const t0 = Date.now();
    await w.json('/reindex', { paths: [FILE] });
    await w.daemon.queue.flush();
    expect(Date.now() - t0).toBeLessThan(2_000);
  }, 60_000);

  it('booting from a snapshot checks git once and rebuilds nothing when nothing changed', async () => {
    const first = await world();
    const root = first.root;
    await first.close();
    let builds = 0;
    const second = await startWorld({ ref, root, seedGraph: false, config: { build: async () => (builds++, Promise.reject(new Error('must not index'))), changed: async () => ({ ok: true, changes: [] }) } });
    worlds.push(second);
    expect(second.daemon.state.source).toBe('snapshot');
    await second.daemon.queue.idle();
    expect(second.daemon.queue.stats.runs).toBe(1); // the automatic detect run
    expect(builds).toBe(0);
    expect(await graphVersion(second)).toBe(ref.graph.version);
  }, 60_000);

  it('validates the body; paths outside the repo are ignored; an unknown file is a harmless delete', async () => {
    const w = await world();
    expect((await w.json('/reindex', { paths: 'nope' })).status).toBe(400);
    expect((await w.json('/reindex', { full: 'yes' })).status).toBe(400);
    expect(await w.json('/reindex', { paths: ['../../etc/passwd', 'C:/Windows/system.ini'] })).toMatchObject({ status: 200, body: { ok: true, queued: 0 } });
    expect(w.daemon.queue.stats.enqueued).toBe(0);
    await w.json('/reindex', { paths: ['src/never-existed.ts'] });
    await w.daemon.queue.flush();
    expect(await graphVersion(w)).toBe(ref.graph.version);
  }, 60_000);

  it('a request that is already running keeps the graph it started with (the swap is invisible to it)', async () => {
    const w = await world();
    const before = w.daemon.state.holder!.current();
    appendFileSync(join(w.root, FILE), ADDED);
    await w.json('/reindex', { paths: [FILE] });
    await w.daemon.queue.flush();
    const after = w.daemon.state.holder!.current();
    expect(after).not.toBe(before);
    expect(before.graph.version).toBe(ref.graph.version);
    expect(before.graph.nodes.some((n) => n.name === 'formatWidgetSerial')).toBe(false); // the old state is untouched
  }, 60_000);

  it('a stale body (file edited since indexing) asks for a re-index by itself', async () => {
    const w = await world({ config: { debounceMs: 30 } });
    appendFileSync(join(w.root, FILE), ADDED);
    const v0 = await graphVersion(w);
    const first = await w.json<PackedContext>('/context', { task: 'formatDate in useFormat' });
    // the file was edited after indexing: its body is withheld this time, and the daemon re-indexes on its own
    expect(first.body.degraded).toContain('stale-body');
    await waitFor(async () => (await graphVersion(w)) !== v0);
    const second = await w.json<PackedContext>('/context', { task: 'formatDate in useFormat' });
    expect(second.body.degraded).not.toContain('stale-body');
  }, 60_000);
});
