// PROMPTS 155 / SPEC §15b: where the learned weights live.
//   .click/weights.json       the current WeightsDoc (atomic write)
//   .click/weights.prev.json  the one before it, so a bad learning step can be rolled back
//   HydraDB                   the multipliers are also written onto the graph's edges (`w`), learned co_changed edges are upserted first;
//                             that copy may lag (WeightSync coalesces and retries in the background), the local file is the truth
// The pipeline reads `w` from HydraDB's EdgeRow (hydra path) or from this document (replica path); after a sync both agree.

import { copyFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { GraphStore } from '../store/types.js';
import type { GraphEdge, WeightsDoc } from '../types.js';
import { renameWithRetry, writeFileAtomic } from '../util/atomic.js';
import type { Logger } from '../util/log.js';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Structural check of a parsed weights file; null when it is not a usable WeightsDoc. */
export function validateWeightsDoc(x: unknown): WeightsDoc | null {
  if (!isObj(x) || x.v !== 1 || typeof x.version !== 'string' || typeof x.events !== 'number' || !isObj(x.multipliers) || !Array.isArray(x.addedEdges) || !isObj(x.params)) return null;
  if (!Object.values(x.multipliers).every((m) => typeof m === 'number' && Number.isFinite(m) && m > 0)) return null;
  const p = x.params;
  if (!['alpha', 'beta', 'min', 'max'].every((k) => typeof p[k] === 'number')) return null;
  if (!x.addedEdges.every((e) => isObj(e) && typeof e.key === 'string' && typeof e.from === 'string' && typeof e.to === 'string' && e.kind === 'co_changed')) return null;
  return x as unknown as WeightsDoc;
}

export class WeightsFile {
  readonly current: string;
  readonly prev: string;

  constructor(dir: string) {
    this.current = join(dir, 'weights.json');
    this.prev = join(dir, 'weights.prev.json');
  }

  private async read(file: string): Promise<WeightsDoc | null> {
    try {
      return validateWeightsDoc(JSON.parse(await readFile(file, 'utf8')));
    } catch {
      return null; // missing, unreadable or corrupt all mean "no weights"
    }
  }

  load(): Promise<WeightsDoc | null> {
    return this.read(this.current);
  }

  loadPrevious(): Promise<WeightsDoc | null> {
    return this.read(this.prev);
  }

  /** Make `doc` current, keeping what was current as `weights.prev.json`. Saving the version that is already current does nothing. */
  async save(doc: WeightsDoc): Promise<boolean> {
    const cur = await this.load();
    if (cur?.version === doc.version) return false;
    if (cur) await copyFile(this.current, `${this.prev}.tmp`).then(() => renameWithRetry(`${this.prev}.tmp`, this.prev));
    await writeFileAtomic(this.current, `${JSON.stringify(doc, null, 2)}\n`);
    return true;
  }

  /** Make the previous version current again (and the version it replaces the new "previous", so a rollback can be undone). */
  async rollback(): Promise<{ from: WeightsDoc; to: WeightsDoc } | null> {
    const [cur, prev] = [await this.load(), await this.loadPrevious()];
    if (!prev) return null;
    const stash = `${this.current}.rollback`;
    if (cur) await copyFile(this.current, stash);
    await writeFileAtomic(this.current, `${JSON.stringify(prev, null, 2)}\n`);
    if (cur) await renameWithRetry(stash, this.prev);
    else await rm(this.prev, { force: true });
    return { from: cur ?? prev, to: prev };
  }
}

/** The multipliers that differ between two docs, as `setEdgeWeights` updates. A key that disappeared goes back to 1 (the neutral weight). */
export function multiplierDiff(prev: WeightsDoc | null, next: WeightsDoc): { key: string; w: number }[] {
  const before = prev?.multipliers ?? {};
  const out: { key: string; w: number }[] = [];
  for (const [key, w] of Object.entries(next.multipliers)) if (before[key] !== w) out.push({ key, w });
  for (const key of Object.keys(before)) if (!(key in next.multipliers)) out.push({ key, w: 1 });
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

export function addedEdgesDiff(prev: WeightsDoc | null, next: WeightsDoc): GraphEdge[] {
  const had = new Set((prev?.addedEdges ?? []).map((e) => e.key));
  return next.addedEdges.filter((e) => !had.has(e.key));
}

export interface WeightSyncOptions {
  log?: Logger;
  /** Backoff between attempts; the last value repeats. */
  retryMs?: readonly number[];
  /**
   * The version of the graph HydraDB holds. Pushing learned co_changed edges must not change it: HydraDB keeps ONE index-version
   * marker (what `click push` compares to know a graph is already there), so writing the weights version into it makes every
   * later push look like a different graph. Absent: the store is asked, and only if it cannot answer is the weights version used.
   */
  graphVersion?: () => string | undefined;
}

/**
 * Keeps HydraDB's edge weights equal to the latest WeightsDoc, in the background. Only the newest target matters: if several
 * documents arrive while a push is running, one follow-up push goes from what HydraDB has to the newest. A failed push is retried
 * with backoff and never blocks anything.
 */
export class WeightSync {
  private synced: WeightsDoc | null = null;
  private target: WeightsDoc | null = null;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private closed = false;
  private waiters: (() => void)[] = [];
  readonly stats = { pushes: 0, failures: 0 };

  constructor(
    private readonly graph: GraphStore,
    private readonly opts: WeightSyncOptions = {},
  ) {}

  /** What HydraDB has, when known (a daemon that just started does not know: its first push sends everything). */
  assume(doc: WeightsDoc | null): void {
    this.synced = doc;
  }

  push(doc: WeightsDoc): void {
    if (this.closed) return;
    this.target = doc;
    if (!this.running && !this.timer) this.kick();
  }

  get busy(): boolean {
    return this.running !== null || this.timer !== undefined || (this.target !== null && this.target.version !== this.synced?.version);
  }

  idle(): Promise<void> {
    return this.busy && !this.closed ? new Promise((r) => this.waiters.push(r)) : Promise.resolve();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.waiters.splice(0).forEach((r) => r());
  }

  /** The graph version to leave in HydraDB's marker while writing learned edges (never the weights version when it can be avoided). */
  private async indexVersion(fallback: string): Promise<string> {
    const known = this.opts.graphVersion?.();
    if (known) return known;
    const store = this.graph as Partial<{ getIndexVersion(): Promise<string | null> }>;
    try {
      return (await store.getIndexVersion?.()) ?? fallback;
    } catch {
      return fallback;
    }
  }

  private kick(): void {
    if (this.running || this.closed) return;
    this.running = this.drain().finally(() => {
      this.running = null;
      if (!this.busy || this.closed) this.waiters.splice(0).forEach((r) => r());
    });
  }

  private async drain(): Promise<void> {
    while (this.target && this.target.version !== this.synced?.version && !this.closed) {
      const next = this.target;
      try {
        const edges = addedEdgesDiff(this.synced, next);
        if (edges.length) await this.graph.upsertGraph({ edges }, await this.indexVersion(next.version)); // learned co_changed edges first: they must exist to carry a weight
        const updates = multiplierDiff(this.synced, next);
        if (updates.length) await this.graph.setEdgeWeights(updates);
        this.synced = next;
        this.stats.pushes++;
        this.failures = 0;
      } catch (e) {
        this.stats.failures++;
        this.failures++;
        const delays = this.opts.retryMs ?? [1_000, 5_000, 30_000];
        const wait = delays[Math.min(this.failures - 1, delays.length - 1)]!;
        this.opts.log?.warn('pushing learned weights to HydraDB failed, will retry', { error: e, retryInMs: wait, attempt: this.failures });
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
