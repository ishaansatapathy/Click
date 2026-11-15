// PROMPTS 111: get the daemon to "ready" as fast as the data allows.
//   1. the CURRENT snapshot on disk (milliseconds)
//   2. else the whole graph out of HydraDB (+ chunk records from the local store)
//   3. else a full index of the repo, saved locally and pushed to HydraDB in the background
// While booting the status is `warming` and /context answers with an empty context flagged `warming`.
// HydraDB being down never stops a boot: it only changes which of the three paths is taken, and /health reports it.

import { join } from 'node:path';
import { GraphHolder } from '../../../core/src/graph/holder.js';
import { SnapshotStore } from '../../../core/src/graph/snapshot.js';
import { WeightsFile } from '../../../core/src/learn/weights.js';
import { buildIndex, graphVersion, type BuildOptions, type BuildResult, type IndexState } from '../../../core/src/indexer/build.js';
import { buildLexical, type Lexical } from '../../../core/src/pipeline.js';
import type { GraphStore, Store } from '../../../core/src/store/types.js';
import type { ChunkRecord, Graph, GraphEdge, GraphNode } from '../../../core/src/types.js';
import type { Logger } from '../../../core/src/util/log.js';
import { clickDir } from '../../../core/src/util/paths.js';
import { withDeadline } from '../../../core/src/util/deadline.js';
import type { Persister } from './persist.js';

/** SPEC §18.1: boot to ready for a 300-file repo with a snapshot. */
export const BOOT_BUDGET_MS = 2_000;

export type BootSource = 'snapshot' | 'hydra' | 'index';

export interface HydraHealth {
  ok: boolean;
  version?: string;
  detail?: string;
  checkedAt: number;
}

export interface BootDeps {
  root: string;
  store: Store;
  graph: GraphStore | null;
  persist: Persister;
  log: Logger;
  build?: (root: string, opts?: BuildOptions) => Promise<BuildResult>;
  /** Options for the full index (for example the git co-change edges). */
  buildOptions?: BuildOptions | undefined;
  /** Give up on HydraDB's loadAll after this long. */
  hydraLoadTimeoutMs?: number;
  now?: () => number;
}

export interface Booted {
  holder: GraphHolder<Lexical>;
  source: BootSource;
  /** Set when this boot ran the indexer: the state incremental re-indexing continues from. */
  indexState: IndexState | null;
  ms: Record<string, number>;
}

export class DaemonState {
  status: 'warming' | 'ready' = 'warming';
  holder: GraphHolder<Lexical> | null = null;
  indexState: IndexState | null = null;
  source: BootSource | null = null;
  bootMs = 0;
  readonly startedAt: number;
  private hydra: HydraHealth | null = null;

  constructor(
    private readonly graph: GraphStore | null,
    now: () => number = Date.now,
    private readonly healthTtlMs = 5_000,
  ) {
    this.clock = now;
    this.startedAt = now();
  }
  private readonly clock: () => number;

  /** HydraDB health, cached for a few seconds and bounded to 300 ms: /health must stay cheap. */
  async hydraHealth(): Promise<HydraHealth> {
    const now = this.clock();
    if (this.hydra && now - this.hydra.checkedAt < this.healthTtlMs) return this.hydra;
    let h: HydraHealth;
    if (!this.graph) {
      h = { ok: false, detail: 'not configured', checkedAt: now };
    } else {
      const ctrl = new AbortController();
      try {
        const r = await withDeadline(this.graph.health(ctrl.signal), 300, () => {
          ctrl.abort();
          return null;
        });
        h = r ? { ...r, checkedAt: now } : { ok: false, detail: 'timeout', checkedAt: now };
      } catch (e) {
        h = { ok: false, detail: e instanceof Error ? e.message : String(e), checkedAt: now };
      }
    }
    this.hydra = h;
    return h;
  }
}

export async function boot(d: BootDeps): Promise<Booted> {
  const now = d.now ?? (() => performance.now());
  const t0 = now();
  const ms: Record<string, number> = {};
  const lap = (name: string, from: number): void => void (ms[name] = Math.round(now() - from));

  const finish = async (graph: Graph, source: BootSource, indexState: IndexState | null): Promise<Booted> => {
    const t = now();
    // learned weights: weights.json is the truth; the store's copy is only a fallback (a repo cloned elsewhere, a deleted .click)
    const weights = (await new WeightsFile(clickDir(d.root)).load()) ?? (await d.store.getWeights().catch(() => null));
    const holder = new GraphHolder<Lexical>(graph, { buildLexical, weights });
    lap('holder', t);
    ms.total = Math.round(now() - t0);
    d.log.info('boot ready', { source, ms, nodes: graph.nodes.length, edges: graph.edges.length, budgetMs: BOOT_BUDGET_MS, overBudget: source === 'snapshot' && ms.total > BOOT_BUDGET_MS });
    return { holder, source, indexState, ms };
  };

  // 1. snapshot
  let t = now();
  const loaded = await new SnapshotStore(join(clickDir(d.root), 'graph')).load();
  lap('snapshot', t);
  if (loaded.ok) return finish(loaded.graph, 'snapshot', null);
  if (loaded.reason !== 'none') d.log.warn('snapshot unusable, rebuilding', { reason: loaded.reason, detail: loaded.detail });

  // 2. HydraDB
  if (d.graph) {
    t = now();
    try {
      const got = await withDeadline(readFromHydra(d), d.hydraLoadTimeoutMs ?? 30_000, () => null);
      lap('hydra', t);
      if (got) {
        await d.persist.saveSnapshot(got.graph, got.chunks);
        return finish(got.graph, 'hydra', null);
      }
      d.log.warn('HydraDB had no usable graph, indexing the repo');
    } catch (e) {
      lap('hydra', t);
      d.log.warn('could not load the graph from HydraDB, indexing the repo', { error: e });
    }
  }

  // 3. index
  t = now();
  const build = await (d.build ? d.build(d.root, d.buildOptions) : buildIndex(d.root, undefined, d.buildOptions));
  lap('index', t);
  t = now();
  await d.persist.saveFull(build.graph, build.chunks, build.conventions);
  lap('persist', t);
  return finish(build.graph, 'index', build.state);
}

/** The graph out of HydraDB plus chunk records from the local store; null when HydraDB holds nothing. */
async function readFromHydra(d: BootDeps): Promise<{ graph: Graph; chunks: ChunkRecord[] } | null> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for await (const page of d.graph!.loadAll()) {
    nodes.push(...(page.nodes ?? []));
    edges.push(...(page.edges ?? []));
  }
  if (nodes.length === 0) return null;
  nodes.sort((a, b) => (a.id < b.id ? -1 : 1));
  edges.sort((a, b) => (a.key < b.key ? -1 : 1));
  const chunks: ChunkRecord[] = [];
  try {
    for await (const page of d.store.loadAll()) chunks.push(...(page.chunks ?? []));
  } catch {
    // no local chunks: semantic seeds and V1 are unavailable until the next index
  }
  const version = graphVersion(
    nodes.map((n) => n.id),
    edges.map((e) => e.key),
    nodes.filter((n) => n.kind === 'file' && n.path).map((n) => ({ path: n.path!, hash: n.fileHash })),
  );
  return { graph: { version, repoCommit: null, nodes, edges, chunks: chunks.map(({ id, nodeId, path, range }) => ({ id, nodeId, path, range })) }, chunks };
}
