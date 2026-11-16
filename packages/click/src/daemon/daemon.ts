// PROMPTS 110–113, 151–156: put the daemon's parts together. `createDaemon` builds everything from injected stores (so tests use
// fakes and `click serve` uses MemoryStore + HydraDB), `start()` opens the HTTP server immediately (status `warming`) and boots
// the graph in the background, `close()` stops it all.
//
// The learning loop lives here too:  /context -> contexts.jsonl,  Stop hook -> /outcome -> outcomes.jsonl,  CheckQueue -> check_result,
// Learner (5 s debounce) -> deriveWeights -> weights.json + live graph + HydraDB edge weights.

import { join } from 'node:path';
import { BodyReader } from '../../../core/src/graph/bodies.js';
import type { DeepPartial, PresetName, VariantConfig } from '../../../core/src/config.js';
import type { LogEvent } from '../../../core/src/contracts.js';
import { CheckQueue, type CommandRunner } from '../../../core/src/learn/check.js';
import type { CoChangeOptions } from '../../../core/src/learn/git-cochange.js';
import { EventLog } from '../../../core/src/learn/log.js';
import { WeightsFile, WeightSync } from '../../../core/src/learn/weights.js';
import { SkeletonProvider } from '../../../core/src/pack/prefix.js';
import type { PrunerRegistry } from '../../../core/src/prune/chain.js';
import type { Embedder, GraphStore, Store } from '../../../core/src/store/types.js';
import { createLogger, type Logger } from '../../../core/src/util/log.js';
import { clickDir } from '../../../core/src/util/paths.js';
import { boot, DaemonState, type BootDeps } from './boot.js';
import { realGit, type GitOps } from './gitdiff.js';
import { GraphSync } from './graphsync.js';
import { JsonlWriter } from './jsonl.js';
import { Learner, weightsRoutes } from './learner.js';
import { outcomeRoute } from './outcome.js';
import { Persister } from './persist.js';
import { createReindexer, ReindexQueue, reindexRoute, type ReindexerDeps } from './reindex.js';
import { impactRoutes } from './impact.js';
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
  gitOps?: GitOps;
  changed?: ReindexerDeps['changed'];
  /** Mine git co-change edges into the graph (the repo's learn.gitCoChange flag). */
  coChange?: CoChangeOptions | undefined;
  /** How checks (vue-tsc, vitest) are run; tests inject fakes. */
  runCheck?: CommandRunner;
  /** Learner debounce (SPEC: 5 s). */
  learnDebounceMs?: number;
}

export interface Daemon {
  state: DaemonState;
  routes: Route[];
  queue: ReindexQueue;
  sessions: SessionMemory;
  stats: StatsKeeper;
  contexts: JsonlWriter;
  outcomes: EventLog<LogEvent>;
  checks: CheckQueue;
  learner: Learner;
  weights: WeightsFile;
  sync: GraphSync | null;
  persist: Persister;
  bodies: BodyReader;
  /** Boot the graph. Resolves when the daemon is `ready`. Never rejects: a failed boot is logged and the status stays `warming`. */
  boot(): Promise<void>;
  /** Open the HTTP server (and start booting). */
  start(): Promise<DaemonHandle>;
  /** Wait until pending background work (re-index queue, HydraDB push, embedding, checks, learning, log writes) has finished. */
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
  const gitOps = c.gitOps ?? realGit;
  const state = new DaemonState(c.graph);
  const buildOptions = c.coChange ? { coChange: c.coChange } : undefined; // learn.gitCoChange: git co-change edges in the graph
  const sync = c.graph ? new GraphSync(c.graph, { log }) : null;
  const persist = new Persister({ root: c.root, store: c.store, sync, embedder: c.embedder, log });
  const sessions = new SessionMemory();
  const stats = new StatsKeeper(dir, log);
  const contextsFile = join(dir, 'contexts.jsonl');
  const outcomesFile = join(dir, 'outcomes.jsonl');
  const contexts = new JsonlWriter(contextsFile, log);

  // learning: logs -> check -> learner -> weights
  const outcomes = new EventLog<LogEvent>(outcomesFile);
  const weights = new WeightsFile(dir);
  const weightSync = c.graph ? new WeightSync(c.graph, { log, graphVersion: () => state.holder?.current().graph.version }) : null;
  const learner = new Learner({ state, outcomesFile, contextsFile, weights, sync: weightSync, store: c.store, log, ...(c.learnDebounceMs !== undefined ? { debounceMs: c.learnDebounceMs } : {}) });
  const checks = new CheckQueue({ root: c.root, outcomes, log, ...(c.runCheck ? { run: c.runCheck } : {}), onResult: () => learner.notify() });

  // The re-index queue is created first so a stale body (a file edited since it was indexed) can ask for a re-index.
  const queue = new ReindexQueue({ run: async (job) => void (await reindex(job)), log, ...(c.debounceMs !== undefined ? { debounceMs: c.debounceMs } : {}) });
  const bodies = new BodyReader(c.root, { honorBlankMarker: true, onStale: (path) => void queue.enqueue({ paths: [path] }) });
  const reindex = createReindexer({ root: c.root, buildOptions, state, persist, bodies, log, ...(c.changed ? { changed: c.changed } : {}) });
  const prefix = new SkeletonProvider({ graphStore: c.graph });

  const routes: Route[] = [
    ...createRoutes({
      root: c.root, version, state, store: c.store, graph: c.graph, embedder: c.embedder, bodies, prefix, pruners: c.pruners, sessions, stats, contexts, log,
      repoConfig: c.repoConfig, gitOps, ...(c.defaultVariant ? { defaultVariant: c.defaultVariant } : {}), ...(c.git ? { git: c.git } : {}),
    }),
    reindexRoute(queue, c.root),
    outcomeRoute({ root: c.root, sessions, outcomes, contextsFile, flushContexts: () => contexts.flush(), checks, onKnownResult: () => learner.notify(), nodes: () => state.holder?.current().graph.nodes ?? [], git: gitOps, log }),
    ...weightsRoutes(learner, weights),
    ...impactRoutes({ state, graph: c.graph, store: c.store }),
  ];

  let booting: Promise<void> | null = null;
  const bootOnce = (): Promise<void> =>
    (booting ??= (async () => {
      try {
        const b = await boot({ root: c.root, buildOptions, store: c.store, graph: c.graph, persist, log, ...(c.build ? { build: c.build } : {}) });
        state.holder = b.holder;
        state.indexState = b.indexState;
        state.source = b.source;
        state.bootMs = b.ms.total ?? 0;
        state.status = 'ready';
        if (b.source === 'snapshot') queue.enqueue({}); // the repo may have changed while no daemon was running
        warmGraphStore(c.graph, b.holder.current().graph.nodes[0]?.id); // the first real request must not pay for opening the connection
        const w = b.holder.current().weights;
        if (w) weightSync?.push(w); // HydraDB may not have the weights this daemon booted with
      } catch (e) {
        log.error('boot failed; staying in warming (requests get an empty context)', { error: e });
      }
    })());

  return {
    state, routes, queue, sessions, stats, contexts, outcomes, checks, learner, weights, sync, persist, bodies,
    boot: bootOnce,
    async start() {
      const handle = await startDaemon({
        root: c.root, dir, routes, version, logger: log,
        ...(c.idleMinutes !== undefined ? { idleMinutes: c.idleMinutes } : {}),
        ...(c.handleSignals !== undefined ? { handleSignals: c.handleSignals } : {}),
        onClose: async () => {
          queue.close();
          learner.close();
          checks.close();
          await Promise.allSettled([contexts.flush(), stats.flush()]);
          sync?.close();
          weightSync?.close();
        },
      });
      void bootOnce();
      return handle;
    },
    async settled() {
      await queue.idle();
      await Promise.all([sync?.idle(), persist.settled(), contexts.flush(), stats.flush(), checks.idle()]);
      await learner.idle();
      await weightSync?.idle();
    },
  };
}
