// Test helper for the daemon suites (not shipped): a repo copy with a ready snapshot, fake stores, and a started daemon.

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, type BuildResult } from '../../../core/src/indexer/build.js';
import { indexSemanticChunks } from '../../../core/src/retrieve/semantic.js';
import { FakeEmbedder, FakeGraphStore, FakeStore } from '../../../core/src/testing/fakes.js';
import { createLogger } from '../../../core/src/util/log.js';
import { createDaemon, type Daemon, type DaemonConfig } from './daemon.js';
import { TOKEN_HEADER, type DaemonHandle } from './server.js';

export const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'core', 'test', 'fixtures', 'mini-vue');
const temps: string[] = [];
export const tmp = (prefix = 'click-d-'): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
export const cleanupTemps = (): void => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
};

export const copyRepo = (from: string = FIXTURE): string => {
  const root = tmp('click-repo-');
  cpSync(from, root, { recursive: true, filter: (src) => !/[\\/]\.click([\\/]|$)/.test(src) });
  return root;
};

export async function reference(): Promise<BuildResult> {
  return buildIndex(FIXTURE, undefined, { cacheDir: tmp(), now: () => new Date('2026-11-15T10:00:00.000Z') });
}

export interface World {
  root: string;
  daemon: Daemon;
  handle: DaemonHandle;
  store: FakeStore;
  graph: FakeGraphStore;
  call: (path: string, init?: RequestInit, token?: string | null) => Promise<Response>;
  json: <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<{ status: number; body: T }>;
  close: () => Promise<void>;
}

/** A started daemon over a fresh copy of the fixture repo. Resolves once booted unless `waitReady` is false. */
export async function startWorld(opts: { ref: BuildResult; root?: string; config?: Partial<DaemonConfig>; waitReady?: boolean; storeLatency?: number; /** false: HydraDB starts empty, so boot indexes the repo (default: it already holds the graph) */ seedGraph?: boolean }): Promise<World> {
  const root = opts.root ?? copyRepo();
  const store = new FakeStore(opts.storeLatency ? { latencyMs: opts.storeLatency } : {});
  const embedder = new FakeEmbedder();
  await indexSemanticChunks(opts.ref.chunks, opts.ref.graph.version, { store, embedder });
  await store.putConventions(opts.ref.conventions);
  const graph = new FakeGraphStore();
  if (opts.seedGraph !== false) await graph.upsertGraph({ nodes: opts.ref.graph.nodes, edges: opts.ref.graph.edges }, opts.ref.graph.version);
  const daemon = createDaemon({
    root, store, graph, embedder, handleSignals: false, debounceMs: 30, idleMinutes: 0,
    log: createLogger('test', { dir: join(root, '.click-test-logs'), env: {} }),
    ...opts.config,
  });
  const handle = await daemon.start();
  if (opts.waitReady !== false) await daemon.boot();
  const call = (path: string, init: RequestInit = {}, token: string | null = handle.info.token) =>
    fetch(`http://127.0.0.1:${handle.info.port}${path}`, { ...init, headers: { ...(token ? { [TOKEN_HEADER]: token } : {}), 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const json = async <T = Record<string, unknown>>(path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const r = await call(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as T };
  };
  return {
    root, daemon, handle, store, graph, call, json,
    close: async () => {
      await daemon.settled().catch(() => undefined);
      await handle.close();
    },
  };
}
