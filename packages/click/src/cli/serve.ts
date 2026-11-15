// PROMPTS 115: `click serve` runs the per-repo daemon in the foreground (clients start it detached when needed).
//   click serve [--root <dir>]

import { join, resolve } from 'node:path';
import { createDaemon, type Daemon } from '../daemon/daemon.js';
import { DaemonLockedError } from '../daemon/lifecycle.js';
import type { DaemonHandle } from '../daemon/server.js';
import { OpenAIEmbedder } from '../../../core/src/store/embed.js';
import { HydraDbGraphStore } from '../../../core/src/store/hydradb-graph.js';
import { MemoryStore } from '../../../core/src/store/memory.js';
import type { Embedder, GraphStore, Store } from '../../../core/src/store/types.js';
import { DiskCache } from '../../../core/src/util/diskCache.js';
import { loadRepoConfig } from '../repo-config.js';
import { VERSION } from '../version.js';
import { parseArgs } from './args.js';
import { pushPaths } from './push-state.js';

export interface ServeIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface ServeDeps {
  store?: Store;
  /** `null` = run without HydraDB. Default: the self-hosted HydraDB configured by env. */
  graph?: GraphStore | null;
  embedder?: Embedder | null;
  /** Tests: don't install SIGINT/SIGTERM handlers, and get the handle once the server is up. */
  handleSignals?: boolean;
  onStarted?: (handle: DaemonHandle, daemon: Daemon) => void;
  debounceMs?: number;
}

export const SERVE_USAGE = 'usage: click serve [--root <dir>]';

export function loadLocalEnv(root: string): void {
  try {
    process.loadEnvFile(join(root, '.env'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

export async function runServe(argv: readonly string[], io: ServeIo, cwd: string = process.cwd(), deps: ServeDeps = {}): Promise<number> {
  const p = parseArgs(argv, { root: 'string' });
  if (p.error || p.positionals.length) {
    io.err(`${p.error ?? `unexpected argument ${p.positionals[0]}`}\n${SERVE_USAGE}`);
    return 2;
  }
  const root = resolve(cwd, p.flags.root ?? '.');
  loadLocalEnv(root);

  const cfg = loadRepoConfig(root);
  if (!cfg.ok) {
    io.err(cfg.error);
    return 1;
  }
  const paths = pushPaths(root);
  const store = deps.store ?? new MemoryStore(paths.memstore);
  let graph: GraphStore | null;
  if (deps.graph !== undefined) graph = deps.graph;
  else {
    try {
      graph = new HydraDbGraphStore();
    } catch {
      graph = null; // no HydraDB configured: the local replica serves everything
    }
  }
  const localOnly = cfg.config.privacy.localOnly;
  const embedder: Embedder | undefined =
    localOnly || deps.embedder === null ? undefined : (deps.embedder ?? (process.env.OPENAI_API_KEY ? new OpenAIEmbedder({ cache: new DiskCache('embed', { dir: paths.cacheDir }) }) : undefined));

  const daemon = createDaemon({
    root, store, graph, embedder, version: VERSION, idleMinutes: cfg.config.daemon.idleMinutes,
    repoConfig: localOnly ? { ...cfg.config.variant, semantic: { ...(cfg.config.variant.semantic ?? {}), mode: 'off' } } : cfg.config.variant,
    ...(deps.handleSignals !== undefined ? { handleSignals: deps.handleSignals } : {}),
    ...(deps.debounceMs !== undefined ? { debounceMs: deps.debounceMs } : {}),
  });

  let handle: DaemonHandle;
  try {
    handle = await daemon.start();
  } catch (e) {
    if (e instanceof DaemonLockedError) {
      io.err(`${e.message}; nothing to do`);
      return 0; // clients race to autostart: losing the race is fine
    }
    throw e;
  }
  io.out(`click daemon ${VERSION} listening on 127.0.0.1:${handle.info.port} (pid ${handle.info.pid}) for ${root}${embedder ? '' : ' [no embeddings: semantic seeds off]'}${graph ? '' : ' [no HydraDB]'}`);
  deps.onStarted?.(handle, daemon);
  await handle.closed;
  return 0;
}
