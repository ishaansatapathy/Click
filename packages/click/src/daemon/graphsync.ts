// PROMPTS 113: keep HydraDB in step with the local graph, in the background.
// The local replica is always correct; HydraDB is a copy that may lag. So pushes never block a request or a re-index:
//   - jobs are coalesced into ONE pending change set (a later upsert beats an earlier delete and vice versa),
//   - one push runs at a time, deletes first, then upserts (the order `click push` uses),
//   - a failed push keeps its changes pending and is retried with backoff, merged with whatever arrived meanwhile.

import type { GraphStore } from '../../../core/src/store/types.js';
import type { GraphDelta, GraphEdge, GraphNode } from '../../../core/src/types.js';
import type { Logger } from '../../../core/src/util/log.js';

export interface GraphChange {
  version: string;
  upsertNodes: GraphNode[];
  upsertEdges: GraphEdge[];
  deleteNodeIds: string[];
  deleteEdgeKeys: string[];
}

export const changeFromDelta = (delta: GraphDelta, version: string): GraphChange => ({
  version,
  upsertNodes: delta.upsertNodes,
  upsertEdges: delta.upsertEdges,
  deleteNodeIds: delta.deleteNodeIds,
  deleteEdgeKeys: delta.deleteEdgeKeys,
});

export const fullChange = (graph: { version: string; nodes: GraphNode[]; edges: GraphEdge[] }): GraphChange => ({
  version: graph.version,
  upsertNodes: graph.nodes,
  upsertEdges: graph.edges,
  deleteNodeIds: [],
  deleteEdgeKeys: [],
});

/** Apply `b` after `a`: the later statement about an id or key wins. */
export function mergeChanges(a: GraphChange, b: GraphChange): GraphChange {
  const nodes = new Map<string, GraphNode | null>();
  const edges = new Map<string, GraphEdge | null>();
  for (const c of [a, b]) {
    for (const id of c.deleteNodeIds) nodes.set(id, null);
    for (const n of c.upsertNodes) nodes.set(n.id, n);
    for (const k of c.deleteEdgeKeys) edges.set(k, null);
    for (const e of c.upsertEdges) edges.set(e.key, e);
  }
  const out: GraphChange = { version: b.version, upsertNodes: [], upsertEdges: [], deleteNodeIds: [], deleteEdgeKeys: [] };
  for (const [id, n] of nodes) {
    if (n) out.upsertNodes.push(n);
    else out.deleteNodeIds.push(id);
  }
  for (const [k, e] of edges) {
    if (e) out.upsertEdges.push(e);
    else out.deleteEdgeKeys.push(k);
  }
  return out;
}

const isEmpty = (c: GraphChange): boolean => !c.upsertNodes.length && !c.upsertEdges.length && !c.deleteNodeIds.length && !c.deleteEdgeKeys.length;

export interface GraphSyncOptions {
  log?: Logger;
  /** Backoff between attempts; the last value repeats. */
  retryMs?: readonly number[];
}

export class GraphSync {
  private pending: GraphChange | null = null;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private closed = false;
  readonly stats = { pushes: 0, failures: 0 };
  private waiters: (() => void)[] = [];

  constructor(
    private readonly graph: GraphStore,
    private readonly opts: GraphSyncOptions = {},
  ) {}

  /** Queue a change. Returns at once; never throws. */
  push(change: GraphChange): void {
    if (this.closed || isEmpty(change)) return;
    this.pending = this.pending ? mergeChanges(this.pending, change) : change;
    if (!this.running && !this.timer) this.kick();
  }

  /** Is anything waiting to be pushed (or being pushed)? */
  get busy(): boolean {
    return this.pending !== null || this.running !== null;
  }

  /** Resolves when everything queued so far has been pushed (or the sync is closed). */
  idle(): Promise<void> {
    return this.busy && !this.closed ? new Promise((r) => this.waiters.push(r)) : Promise.resolve();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.waiters.splice(0).forEach((r) => r());
  }

  private kick(): void {
    if (this.running || this.closed) return;
    this.running = this.drain().finally(() => {
      this.running = null;
      if (!this.busy || this.closed) this.waiters.splice(0).forEach((r) => r());
    });
  }

  private async drain(): Promise<void> {
    while (this.pending && !this.closed) {
      const job = this.pending;
      this.pending = null;
      try {
        if (job.deleteNodeIds.length || job.deleteEdgeKeys.length) await this.graph.removeGraph({ nodeIds: job.deleteNodeIds, edgeKeys: job.deleteEdgeKeys });
        if (job.upsertNodes.length || job.upsertEdges.length) await this.graph.upsertGraph({ nodes: job.upsertNodes, edges: job.upsertEdges }, job.version);
        this.stats.pushes++;
        this.failures = 0;
      } catch (e) {
        this.stats.failures++;
        this.failures++;
        this.pending = this.pending ? mergeChanges(job, this.pending) : job; // keep it, in order, for the retry
        const wait = (this.opts.retryMs ?? [1_000, 5_000, 30_000])[Math.min(this.failures - 1, (this.opts.retryMs ?? [1, 2, 3]).length - 1)]!;
        this.opts.log?.warn('graph push failed, will retry', { error: e, retryInMs: wait, attempt: this.failures });
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.kick();
        }, wait);
        this.timer.unref?.();
        return;
      }
    }
  }
}
