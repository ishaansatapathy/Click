// PROMPTS 113: keep the graph current while the repo changes.
//   ReindexQueue   debounce (2 s), single flight, path coalescing: ten edits in a burst are one re-index
//   createReindexer  what one re-index does: update the index incrementally, swap the new graph into the holder (requests
//                    already running keep the old one), save the snapshot, and push the delta to HydraDB in the background.
//   reindexRoute   POST /reindex { paths?, full? } -> { ok, queued }

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { buildIndex, type BuildOptions, type BuildResult, type IndexState } from '../../../core/src/indexer/build.js';
import { changedPaths } from '../../../core/src/indexer/changed.js';
import { diffGraphs, updateIndex, type ChangedPath } from '../../../core/src/indexer/incremental.js';
import { normPath } from '../../../core/src/util/ids.js';
import type { Logger } from '../../../core/src/util/log.js';
import type { ChunkRecord } from '../../../core/src/types.js';
import type { DaemonState } from './boot.js';
import type { Persister } from './persist.js';
import type { Route } from './server.js';

export const reindexRequestSchema = z.object({
  paths: z.array(z.string().min(1).max(1_000)).max(5_000).optional(),
  full: z.boolean().optional(),
});

export interface ReindexJob {
  /** Paths to re-read. Empty with `detect`: ask git what changed. */
  paths: Set<string>;
  detect: boolean;
  full: boolean;
}

export interface ReindexQueueOptions {
  run: (job: ReindexJob) => Promise<void>;
  log?: Logger;
  debounceMs?: number;
  /** A steady stream of edits still gets a re-index at least this often. */
  maxWaitMs?: number;
  maxAttempts?: number;
}

export class ReindexQueue {
  private pending: ReindexJob | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firstAt = 0;
  private running: Promise<void> | null = null;
  private attempts = 0;
  private waiters: (() => void)[] = [];
  readonly stats = { enqueued: 0, runs: 0, failures: 0, maxConcurrent: 0 };
  private active = 0;

  constructor(private readonly o: ReindexQueueOptions) {}

  /** Add paths (or ask for a detect / full run). Never throws. Returns how many paths are waiting. */
  enqueue(req: { paths?: readonly string[]; full?: boolean } = {}): { queued: number } {
    this.stats.enqueued++;
    const job = (this.pending ??= { paths: new Set(), detect: false, full: false });
    for (const p of req.paths ?? []) job.paths.add(p);
    if (req.full) job.full = true;
    else if (!req.paths?.length) job.detect = true;
    this.schedule();
    return { queued: job.paths.size };
  }

  get busy(): boolean {
    return this.pending !== null || this.running !== null;
  }

  /** Resolves when nothing is waiting and nothing is running. */
  idle(): Promise<void> {
    return this.busy ? new Promise((r) => this.waiters.push(r)) : Promise.resolve();
  }

  /** Run what is waiting now instead of after the debounce. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.running && this.pending) this.start();
    await this.idle();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = null;
    this.release();
  }

  private schedule(): void {
    if (this.running) return; // the run's own completion schedules the follow-up
    const now = Date.now();
    if (!this.firstAt) this.firstAt = now;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.o.debounceMs ?? 2_000, this.firstAt + (this.o.maxWaitMs ?? 10_000) - now));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.start();
    }, wait);
    this.timer.unref?.();
  }

  private start(): void {
    if (this.running || !this.pending) return;
    const job = this.pending;
    this.pending = null;
    this.firstAt = 0;
    this.running = (async () => {
      this.active++;
      this.stats.maxConcurrent = Math.max(this.stats.maxConcurrent, this.active);
      try {
        this.stats.runs++;
        await this.o.run(job);
        this.attempts = 0;
      } catch (e) {
        this.stats.failures++;
        this.attempts++;
        if (this.attempts < (this.o.maxAttempts ?? 3)) {
          this.o.log?.warn('re-index failed, will retry', { error: e, attempt: this.attempts });
          const again = (this.pending ??= { paths: new Set(), detect: false, full: false });
          job.paths.forEach((p) => again.paths.add(p));
          again.detect ||= job.detect;
          again.full ||= job.full;
        } else {
          this.o.log?.error('re-index failed, giving up on this change set (the next change will retry)', { error: e });
          this.attempts = 0;
        }
      } finally {
        this.active--;
        this.running = null;
        if (this.pending) this.schedule();
        else this.release();
      }
    })();
  }

  private release(): void {
    if (!this.busy) this.waiters.splice(0).forEach((r) => r());
  }
}

// ---------------------------------------------------------------- what one re-index does

export interface ReindexerDeps {
  root: string;
  state: DaemonState;
  persist: Persister;
  /** Forget cached file bodies of changed paths. */
  bodies: { invalidate(path?: string): void };
  log: Logger;
  build?: (root: string, opts?: BuildOptions) => Promise<BuildResult>;
  buildOptions?: BuildOptions | undefined;
  update?: typeof updateIndex;
  changed?: typeof changedPaths;
}

export interface ReindexOutcome {
  changed: boolean;
  mode: 'incremental' | 'full' | 'none';
  files: number;
  ms: number;
  graphVersion: string;
}

export function createReindexer(d: ReindexerDeps): (job: ReindexJob) => Promise<ReindexOutcome> {
  return async (job) => {
    const t0 = performance.now();
    const holder = d.state.holder;
    if (d.state.status !== 'ready' || !holder) throw new Error('daemon is still warming up');
    const prevGraph = holder.current().graph;

    let nextState: IndexState;
    let delta;
    let mode: ReindexOutcome['mode'] = 'incremental';
    let files = job.paths.size;
    const prev = d.state.indexState;

    // booted from a snapshot (no IndexState yet) and git says nothing changed since it was taken: nothing to do, no rebuild
    if (!job.full && !prev && job.detect && job.paths.size === 0) {
      const found = await (d.changed ?? changedPaths)(d.root, prevGraph.repoCommit);
      if (found.ok && found.changes.length === 0) {
        d.log.info('re-index: nothing changed since the snapshot');
        return { changed: false, mode: 'none', files: 0, ms: Math.round(performance.now() - t0), graphVersion: prevGraph.version };
      }
    }

    let changes: ChangedPath[] | null = null;
    if (!job.full && prev) {
      if (job.paths.size > 0 || !job.detect) {
        changes = [...job.paths].flatMap((p) => {
          try {
            const rel = normPath(d.root, p);
            return [{ path: rel, status: existsSync(join(d.root, rel)) ? ('M' as const) : ('D' as const) }];
          } catch {
            return []; // outside the repo
          }
        });
      } else {
        const found = await (d.changed ?? changedPaths)(d.root, prevGraph.repoCommit);
        if (found.ok) changes = found.changes;
      }
    }

    if (changes && prev) {
      const r = await (d.update ?? updateIndex)(prev, changes);
      nextState = r.state;
      delta = r.delta;
      mode = r.stats.fullRebuild ? 'full' : 'incremental';
      files = changes.length;
    } else {
      // first re-index after booting from a snapshot, a full request, or git could not tell us: rebuild (extract cache keeps it fast)
      const b = await (d.build ? d.build(d.root, d.buildOptions) : buildIndex(d.root, undefined, d.buildOptions));
      nextState = b.state;
      delta = diffGraphs({ graph: prevGraph, chunks: prevGraph.chunks as ChunkRecord[] }, { graph: b.graph, chunks: b.chunks });
      mode = 'full';
      files = b.state.files.size;
    }

    const graph = nextState.graph;
    const unchanged = graph.version === prevGraph.version;
    d.state.indexState = nextState;
    if (!unchanged) {
      holder.swapGraph(graph); // requests in flight keep the graph they started with
      for (const c of changes ?? []) d.bodies.invalidate(c.path);
      if (mode === 'full') d.bodies.invalidate();
      try {
        await d.persist.saveDelta(graph, nextState.chunks, nextState.conventions, delta);
      } catch (e) {
        d.log.error('re-index: could not save (the in-memory graph is current)', { error: e });
      }
    }
    const ms = Math.round(performance.now() - t0);
    d.log.info('re-indexed', { mode, files, ms, from: prevGraph.version, to: graph.version, unchanged, delta: { nodes: [delta.upsertNodes.length, delta.deleteNodeIds.length], edges: [delta.upsertEdges.length, delta.deleteEdgeKeys.length] } });
    return { changed: !unchanged, mode: unchanged ? 'none' : mode, files, ms, graphVersion: graph.version };
  };
}

export function reindexRoute(queue: ReindexQueue, root: string): Route {
  return {
    method: 'POST',
    path: '/reindex',
    handle({ body }) {
      const req = reindexRequestSchema.parse(body);
      const paths = (req.paths ?? []).flatMap((p) => {
        try {
          return [normPath(root, p)];
        } catch {
          return []; // not inside this repo: ignore rather than fail the whole request
        }
      });
      if (req.paths?.length && paths.length === 0) return { ok: true, queued: 0 }; // every path was outside the repo
      const { queued } = queue.enqueue({ paths, ...(req.full ? { full: true } : {}) });
      return { ok: true, queued };
    },
  };
}
