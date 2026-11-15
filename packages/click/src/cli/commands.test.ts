import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SnapshotStore } from '../../../core/src/graph/snapshot.js';
import type { BuildResult } from '../../../core/src/indexer/build.js';
import { FakeEmbedder, FakeGraphStore, FakeStore } from '../../../core/src/testing/fakes.js';
import { ClickClient } from '../client.js';
import { copyRepo, cleanupTemps, reference } from '../daemon/testkit.js';
import { writeInfo } from '../daemon/lifecycle.js';
import { startHttp, type HttpHandle, type Route } from '../daemon/server.js';
import { loadRepoConfig } from '../repo-config.js';
import { VERSION } from '../version.js';
import { parseArgs } from './args.js';
import { runContext } from './context.js';
import { dispatch } from './index.js';
import { runIndex } from './indexCmd.js';
import { runReindex } from './reindexCmd.js';
import { runServe } from './serve.js';
import { runStatus } from './status.js';

function capture() {
  let o = '';
  let e = '';
  return { io: { out: (t: string) => (o += `${t}\n`), err: (t: string) => (e += `${t}\n`) }, out: () => o, err: () => e };
}

describe('parseArgs', () => {
  const spec = { json: 'bool', budget: 'number', variant: 'string' } as const;
  it('flags, values, = form, positionals and --', () => {
    const p = parseArgs(['fix the thing', '--json', '--budget', '2000', '--variant=V3', '--', '--not-a-flag'], spec);
    expect(p).toEqual({ flags: { json: true, budget: 2000, variant: 'V3' }, positionals: ['fix the thing', '--not-a-flag'] });
    expect(parseArgs(['--json=false'], spec).flags.json).toBe(false);
  });
  it('reports unknown flags, missing values and non-numbers', () => {
    expect(parseArgs(['--nope'], spec).error).toBe('unknown option --nope');
    expect(parseArgs(['--budget'], spec).error).toBe('--budget needs a value');
    expect(parseArgs(['--budget', 'lots'], spec).error).toContain('needs a number');
    expect(parseArgs(['--toString'], spec).error).toBe('unknown option --toString');
  });
});

describe('loadRepoConfig', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const write = (text: string) => {
    root = mkdtempSync(join(tmpdir(), 'click-cfg-'));
    writeFileSync(join(root, 'click.config.json'), text);
  };
  it('no file: defaults', () => {
    root = mkdtempSync(join(tmpdir(), 'click-cfg-'));
    expect(loadRepoConfig(root)).toMatchObject({ ok: true, found: false, config: { daemon: { idleMinutes: 240 }, hook: { mode: 'always' }, privacy: { localOnly: false }, variant: {} } });
  });
  it('splits the file into variant overrides and the daemon / hook / privacy sections', () => {
    write(JSON.stringify({ budgetTokens: 3000, daemon: { idleMinutes: 30 }, hook: { mode: 'first', budgetTokens: 2500 }, privacy: { localOnly: true } }));
    expect(loadRepoConfig(root)).toMatchObject({ ok: true, found: true, config: { variant: { budgetTokens: 3000 }, daemon: { idleMinutes: 30 }, hook: { mode: 'first', budgetTokens: 2500 }, privacy: { localOnly: true } } });
  });
  it('explains invalid JSON, bad sections and bad variant values', () => {
    write('{ nope');
    expect(loadRepoConfig(root)).toMatchObject({ ok: false, error: expect.stringContaining('not valid JSON') });
    write(JSON.stringify({ hook: { mode: 'sometimes' } }));
    expect(loadRepoConfig(root)).toMatchObject({ ok: false, error: expect.stringContaining('hook.mode') });
    write(JSON.stringify({ budgetTokens: 5 }));
    expect(loadRepoConfig(root)).toMatchObject({ ok: false, error: expect.stringContaining('click.config.json') });
    write('[]');
    expect(loadRepoConfig(root).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- commands against a fake daemon

let ref: BuildResult;
beforeAll(async () => {
  ref = await reference();
}, 60_000);
afterAll(cleanupTemps);

const handles: HttpHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
});

async function fakeDaemon(root: string, routes: Route[]): Promise<{ client: ClickClient; calls: { path: string; body: unknown }[] }> {
  const calls: { path: string; body: unknown }[] = [];
  const rec = (path: string, out: unknown): Route[] => [
    { method: 'GET', path, handle: () => (calls.push({ path, body: undefined }), out) },
    { method: 'POST', path, handle: ({ body }) => (calls.push({ path, body }), out) },
  ];
  const h = await startHttp({ token: 't', routes: [...routes, ...rec('/noop', {})] });
  handles.push(h);
  await writeInfo(join(root, '.click'), { v: 1, pid: process.pid, port: h.port, token: 't', startedAt: '2026-11-15T10:00:00.000Z', version: '0.1.0', root });
  return { client: new ClickClient({ root, spawnFn: () => { throw new Error('must not spawn'); } }), calls };
}
const health = { ok: true, status: 'ready', version: '0.1.0', graphVersion: 'g123', nodes: 10, edges: 20, uptimeMs: 65_000, bootSource: 'snapshot', bootMs: 120, weightsVersion: null, hydra: { ok: false, detail: 'connection refused' } };
const stats = { last: { contextId: 'c1', tokens: 1234, files: 4, ms: 210, pruner: 'none', degraded: ['semantic-timeout'], ts: '2026-11-15T10:00:00.000Z' }, session: {}, totals: { contexts: 7, tokens: 8000 } };

describe('click context (PROMPTS 115)', () => {
  it('prints the packed text, with a one-line summary on stderr', async () => {
    const root = mkdtempSync(join(tmpdir(), 'click-cmd-'));
    const bodies: unknown[] = [];
    const { client } = await fakeDaemon(root, [
      { method: 'GET', path: '/health', handle: () => health },
      { method: 'POST', path: '/context', handle: ({ body }) => (bodies.push(body), { text: '<click_context>hello</click_context>', tokens: 40, budget: 1500, items: [{}], degraded: [], timings: { total: 12 } }) },
    ]);
    const c = capture();
    expect(await runContext(['add a loading state to checkout', '--budget', '1500', '--variant', 'V3'], c.io, root, { client })).toBe(0);
    expect(c.out()).toBe('<click_context>hello</click_context>\n');
    expect(c.err()).toContain('40/1500 tokens');
    expect(bodies).toEqual([{ task: 'add a loading state to checkout', source: 'cli', budgetTokens: 1500, variant: 'V3' }]);
  });

  it('--json prints the whole packed context; --stdin reads the task from stdin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'click-cmd-'));
    const bodies: { task: string }[] = [];
    const { client } = await fakeDaemon(root, [
      { method: 'GET', path: '/health', handle: () => health },
      { method: 'POST', path: '/context', handle: ({ body }) => (bodies.push(body as { task: string }), { text: 'T', tokens: 1, budget: 4000, items: [], degraded: [], timings: {}, contextId: 'c9' }) },
    ]);
    const c = capture();
    expect(await runContext(['--stdin', '--json'], c.io, root, { client, readStdin: async () => '  task from a pipe \n' })).toBe(0);
    expect(JSON.parse(c.out())).toMatchObject({ text: 'T', contextId: 'c9' });
    expect(bodies[0]!.task).toBe('task from a pipe');
  });

  it('an empty answer says why on stderr; no task, bad flags and a failing daemon are reported with exit codes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'click-cmd-'));
    const { client } = await fakeDaemon(root, [
      { method: 'GET', path: '/health', handle: () => health },
      { method: 'POST', path: '/context', handle: () => ({ text: '', tokens: 0, budget: 4000, items: [], degraded: ['warming'], timings: {} }) },
    ]);
    const a = capture();
    expect(await runContext(['x'], a.io, root, { client })).toBe(0);
    expect(a.err()).toContain('degraded: warming');
    const b = capture();
    expect(await runContext([], b.io, root, { client })).toBe(2);
    expect(b.err()).toContain('no task given');
    expect(await runContext(['--bogus'], capture().io, root, { client })).toBe(2);
    const d = capture();
    expect(await runContext(['x'], d.io, root, { client: new ClickClient({ root: mkdtempSync(join(tmpdir(), 'click-none-')), spawnFn: () => ({ unref: () => undefined }) }), startWaitMs: 300 })).toBe(1);
    expect(d.err()).toContain('did not become ready');
  });
});

describe('click status (PROMPTS 115)', () => {
  it('summarises the daemon, graph, HydraDB and the last context; --json gives it raw', async () => {
    const root = mkdtempSync(join(tmpdir(), 'click-cmd-'));
    const { client } = await fakeDaemon(root, [
      { method: 'GET', path: '/health', handle: () => health },
      { method: 'GET', path: '/stats', handle: () => stats },
    ]);
    const c = capture();
    expect(await runStatus([], c.io, root, { client })).toBe(0);
    expect(c.out()).toContain('click daemon 0.1.0: ready, up 1 min (booted from snapshot in 120 ms)');
    expect(c.out()).toContain('graph:   g123 · 10 nodes · 20 edges');
    expect(c.out()).toContain('hydradb: unavailable (connection refused): serving from the local replica');
    expect(c.out()).toContain('7 contexts, 8000 tokens');
    expect(c.out()).toContain('degraded: semantic-timeout');
    const j = capture();
    await runStatus(['--json'], j.io, root, { client });
    expect(JSON.parse(j.out())).toMatchObject({ running: true, health: { graphVersion: 'g123' }, stats: { totals: { contexts: 7 } } });
  });

  it('no daemon: says so and exits 0', async () => {
    const root = mkdtempSync(join(tmpdir(), 'click-none-'));
    const c = capture();
    expect(await runStatus([], c.io, root, { client: new ClickClient({ root }) })).toBe(0);
    expect(c.out()).toContain('not running');
    const j = capture();
    await runStatus(['--json'], j.io, root, { client: new ClickClient({ root }) });
    expect(JSON.parse(j.out())).toEqual({ running: false });
  });
});

describe('click reindex (PROMPTS 115)', () => {
  it('sends paths, "detect" (--changed or nothing) or full, and reports what was queued', async () => {
    const root = mkdtempSync(join(tmpdir(), 'click-cmd-'));
    const bodies: unknown[] = [];
    const { client } = await fakeDaemon(root, [{ method: 'POST', path: '/reindex', handle: ({ body }) => (bodies.push(body), { ok: true, queued: (body as { paths?: string[] }).paths?.length ?? 0 }) }]);
    const a = capture();
    expect(await runReindex(['src/a.ts', 'src/b.ts'], a.io, root, { client })).toBe(0);
    expect(a.out()).toContain('2 paths');
    expect((bodies[0] as { paths: string[] }).paths.map((p) => p.replace(/\\/g, '/').split('/').slice(-2).join('/'))).toEqual(['src/a.ts', 'src/b.ts']);
    await runReindex(['--changed'], capture().io, root, { client });
    await runReindex(['--full'], capture().io, root, { client });
    expect(bodies.slice(1)).toEqual([{}, { full: true }]);
  });

  it('with no daemon it does nothing and exits 0 (so a git hook never fails or starts a process)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'click-none-'));
    const spawned: unknown[] = [];
    const c = capture();
    expect(await runReindex(['--changed'], c.io, root, { client: new ClickClient({ root, spawnFn: () => (spawned.push(1), { unref: () => undefined }) }) })).toBe(0);
    expect(spawned).toHaveLength(0);
    expect(c.out()).toContain('not running');
    expect(await runReindex(['--wat'], capture().io, root)).toBe(2);
  });
});

describe('click index (PROMPTS 115)', () => {
  it('builds the graph locally, saves the snapshot and the store, without a daemon', async () => {
    const root = copyRepo();
    const store = new FakeStore();
    const c = capture();
    expect(await runIndex(['--full'], c.io, root, { store, client: new ClickClient({ root }) })).toBe(0);
    expect(c.out()).toMatch(/Indexed \d+ files in \d+ ms: \d+ nodes, \d+ edges, \d+ chunks · graph [0-9a-f]{12} \(full rebuild\)/);
    expect((await new SnapshotStore(join(root, '.click', 'graph')).load()).ok).toBe(true);
    expect(store.chunks.size).toBeGreaterThan(0);
  }, 60_000);

  it('with a daemon running it asks the daemon instead of indexing twice', async () => {
    const root = mkdtempSync(join(tmpdir(), 'click-cmd-'));
    const bodies: unknown[] = [];
    const { client } = await fakeDaemon(root, [{ method: 'POST', path: '/reindex', handle: ({ body }) => (bodies.push(body), { ok: true, queued: 0 }) }]);
    const c = capture();
    expect(await runIndex(['--full'], c.io, root, { client })).toBe(0);
    expect(bodies).toEqual([{ full: true }]);
    expect(c.out()).toContain('daemon is running');
  });
});

describe('click serve + click context against it (PROMPTS 115 done-criterion)', () => {
  it('serves the fixture repo, and `click context` prints a packed context for a task', async () => {
    const root = copyRepo();
    const store = new FakeStore();
    const graph = new FakeGraphStore();
    const embedder = new FakeEmbedder();
    const { indexSemanticChunks } = await import('../../../core/src/retrieve/semantic.js');
    await indexSemanticChunks(ref.chunks, ref.graph.version, { store, embedder });

    let stop!: () => Promise<void>;
    const s = capture();
    const serving = runServe(['--root', root], s.io, process.cwd(), { store, graph, embedder, handleSignals: false, debounceMs: 30, onStarted: (h) => (stop = () => h.close()) });

    const client = new ClickClient({ root, spawnFn: () => { throw new Error('daemon should already be running'); } });
    const c = capture();
    expect(await runContext(['add a loading state to the checkout button when submitting the order'], c.io, root, { client, startWaitMs: 60_000 })).toBe(0);
    expect(c.out()).toContain('<click_context version="1"');
    expect(c.out()).toContain('CheckoutButton');
    expect(c.err()).toMatch(/\d+\/4000 tokens/);

    const st = capture();
    expect(await runStatus([], st.io, root, { client })).toBe(0);
    expect(st.out()).toContain('ready');
    expect(st.out()).toContain('1 context');

    await stop();
    expect(await serving).toBe(0);
    expect(s.out()).toContain('listening on 127.0.0.1');
    expect(existsSync(join(root, '.click', 'daemon.json'))).toBe(false);
    expect(readFileSync(join(root, '.click', 'contexts.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  }, 90_000);

  it('a second serve for the same repo exits quietly with 0; a bad click.config.json exits 1 with the reason', async () => {
    const root = copyRepo();
    let first!: () => Promise<void>;
    const a = runServe(['--root', root], capture().io, process.cwd(), { store: new FakeStore(), graph: null, embedder: null, handleSignals: false, onStarted: (h) => (first = () => h.close()) });
    await new Promise((r) => setTimeout(r, 300));
    const second = capture();
    expect(await runServe(['--root', root], second.io, process.cwd(), { store: new FakeStore(), graph: null, embedder: null, handleSignals: false })).toBe(0);
    expect(second.err()).toContain('another click daemon');
    await first();
    await a;

    const bad = copyRepo();
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'click.config.json'), '{ "hook": { "mode": "nope" } }');
    const e = capture();
    expect(await runServe(['--root', bad], e.io, process.cwd(), { store: new FakeStore(), graph: null })).toBe(1);
    expect(e.err()).toContain('hook.mode');
    expect(await runServe(['--zzz'], capture().io, process.cwd())).toBe(2);
  }, 60_000);
});

describe('dispatcher', () => {
  it('--version prints the version', async () => {
    const c = capture();
    expect(await dispatch(['--version'], c.io)).toBe(0);
    expect(c.out()).toBe(`${VERSION}\n`);
  });
});
