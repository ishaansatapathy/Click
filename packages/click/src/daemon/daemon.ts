// PROMPTS 110–113: put the daemon's parts together. `createDaemon` builds everything from injected stores (so tests use
// fakes and `click serve` uses MemoryStore + HydraDB), `start()` opens the HTTP server immediately (status `warming`) and boots
// the graph in the background, `close()` stops it all.

import { join } from 'node:path';
import { BodyReader } from '../../../core/src/graph/bodies.js';
import type { DeepPartial, PresetName, VariantConfig } from '../../../core/src/config.js';
import { SkeletonProvider } from '../../../core/src/pack/prefix.js';
import type { PrunerRegistry } from '../../../core/src/prune/chain.js';
import type { Embedder, GraphStore, Store } from '../../../core/src/store/types.js';
import { createLogger, type Logger } from '../../../core/src/util/log.js';
import { clickDir } from '../../../core/src/util/paths.js';
import { boot, DaemonState, type BootDeps } from './boot.js';
import { GraphSync } from './graphsync.js';
import { JsonlWriter } from './jsonl.js';
import { Persister } from './persist.js';
import { createReindexer, ReindexQueue, reindexRoute, type ReindexerDeps } from './reindex.js';
import { createRoutes } from './routes.js';
import { startDaemon, type DaemonHandle, type Route } from './server.js';
import { SessionMemory } from './sessions.js';
import { StatsKeeper } from './stats.js';

export interface DaemonConfig {
  root: string;
  store: Store;
  graph: GraphStore | null;
  embedder?: Embedder | undefined;
  pruners?: PrunerRegistry | undefined;
  version?: string;
  repoConfig?: DeepPartial<VariantConfig> | null | undefined;
  defaultVariant?: PresetName | undefined;
  log?: Logger;
  /** Re-index debounce (SPEC: 2 s). */
  debounceMs?: number;
  idleMinutes?: number;
  /** Test hooks. */
  build?: BootDeps['build'];
  handleSignals?: boolean;
  git?: (root: string) => Promise<string | null>;
  changed?: ReindexerDeps['changed'];
}

export interface Daemon {
  state: DaemonState;
  routes: Route[];
  queue: ReindexQueue;
  sessions: SessionMemory;
  stats: StatsKeeper;
  contexts: JsonlWriter;
  sync: GraphSync | null;
  persist: Persister;
  bodies: BodyReader;
  /** Boot the graph. Resolves when the daemon is `ready`. Never rejects: a failed boot is logged and the status stays `warming`. */
  boot(): Promise<void>;
  /** Open the HTTP server (and start booting). */
  start(): Promise<DaemonHandle>;
  /** Wait until pending background work (re-index queue, HydraDB push, embedding, log writes) has finished. */
  settled(): Promise<void>;
}

/**
 * One throwaway neighbourhood query right after boot. The very first HydraDB call of a process (connection, token read, JIT) takes
 * longer than the 250 ms the hot path allows, so without this the first request after every start fell back to the local replica.
 * Failures are ignored: this is only a warm-up.
 */
export function warmGraphStore(graph: GraphStore | null, nodeId: string | undefined): void {
  if (!graph || !nodeId) return;
  void graph.neighbourhood([nodeId], { hops: 2, maxFrontier: 50 }, AbortSignal.timeout(5_000)).catch(() => undefined);
}

export function createDaemon(c: DaemonConfig): Daemon {
  const dir = clickDir(c.root);
  const log = c.log ?? createLogger('daemon', { dir: join(dir, 'logs') });
  const version = c.version ?? '0.0.0';
  const state = new DaemonState(c.graph);
  const sync = c.graph ? new GraphSync(c.graph, { log }) : null;
  const persist = new Persister({ root: c.root, store: c.store, sync, embedder: c.embedder, log });
  const sessions = new SessionMemory();
  const stats = new StatsKeeper(dir, log);
  const contexts = new JsonlWriter(join(dir, 'contexts.jsonl'), log);

  // The re-index queue is created first so a stale body (a file edited since it was indexed) can ask for a re-index.
  const queue = new ReindexQueue({ run: async (job) => void (await reindex(job)), log, ...(c.debounceMs !== undefined ? { debounceMs: c.debounceMs } : {}) });
  const bodies = new BodyReader(c.root, { onStale: (path) => void queue.enqueue({ paths: [path] }) });
  const reindex = createReindexer({ root: c.root, state, persist, bodies, log, ...(c.changed ? { changed: c.changed } : {}) });
  const prefix = new SkeletonProvider({ graphStore: c.graph });

  const routes: Route[] = [
    ...createRoutes({
      root: c.root, version, state, store: c.store, graph: c.graph, embedder: c.embedder, bodies, prefix, pruners: c.pruners, sessions, stats, contexts, log,
      repoConfig: c.repoConfig, ...(c.defaultVariant ? { defaultVariant: c.defaultVariant } : {}), ...(c.git ? { git: c.git } : {}),
    }),
    reindexRoute(queue, c.root),
  ];

  let booting: Promise<void> | null = null;
  const bootOnce = (): Promise<void> =>
    (booting ??= (async () => {
      try {
        const b = await boot({ root: c.root, store: c.store, graph: c.graph, persist, log, ...(c.build ? { build: c.build } : {}) });
        state.holder = b.holder;
        state.indexState = b.indexState;
        state.source = b.source;
        state.bootMs = b.ms.total ?? 0;
        state.status = 'ready';
        if (b.source === 'snapshot') queue.enqueue({}); // the repo may have changed while no daemon was running
        warmGraphStore(c.graph, b.holder.current().graph.nodes[0]?.id); // the first real request must not pay for opening the connection
      } catch (e) {
        log.error('boot failed; staying in warming (requests get an empty context)', { error: e });
      }
    })());

  return {
    state, routes, queue, sessions, stats, contexts, sync, persist, bodies,
    boot: bootOnce,
    async start() {
      const handle = await startDaemon({
        root: c.root, dir, routes, version, logger: log,
        ...(c.idleMinutes !== undefined ? { idleMinutes: c.idleMinutes } : {}),
        ...(c.handleSignals !== undefined ? { handleSignals: c.handleSignals } : {}),
        onClose: async () => {
          queue.close();
          await Promise.allSettled([contexts.flush(), stats.flush()]);
          sync?.close();
        },
      });
      void bootOnce();
      return handle;
    },
    async settled() {
      await queue.idle();
      await Promise.all([sync?.idle(), persist.settled(), contexts.flush(), stats.flush()]);
    },
  };
}
