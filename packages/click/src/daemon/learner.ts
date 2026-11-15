// PROMPTS 156 / 155: the background learner. When something learnable happens (an outcome whose result is known, or a check_result),
// wait 5 s (more events may follow), re-derive the weights from the WHOLE logs (pure and fast: ~75 ms for 10,000 events, so there is
// no incremental state to get wrong), and if they changed: save weights.json (keeping the previous), swap them into the live graph,
// and write them onto HydraDB's edges in the background. Requests already running keep the weights they started with.
// Future work: incremental derive, if logs ever grow past ~100k events.

import { deriveWeights, DEFAULT_PARAMS } from '../../../core/src/learn/derive.js';
import { readEvents } from '../../../core/src/learn/log.js';
import { WeightsFile, WeightSync } from '../../../core/src/learn/weights.js';
import type { ContextRecord, LogEvent } from '../../../core/src/contracts.js';
import type { Store } from '../../../core/src/store/types.js';
import type { LearnParams, WeightsDoc } from '../../../core/src/types.js';
import type { Logger } from '../../../core/src/util/log.js';
import type { DaemonState } from './boot.js';
import type { Route } from './server.js';

export interface LearnerOptions {
  state: DaemonState;
  outcomesFile: string;
  contextsFile: string;
  weights: WeightsFile;
  sync: WeightSync | null;
  store: Store;
  log: Logger;
  debounceMs?: number;
  params?: LearnParams;
}

export interface LearnRun {
  changed: boolean;
  events: number;
  ms: number;
  version: string | null;
  skipped?: 'warming';
}

const isEvent = (v: unknown): v is LogEvent => typeof v === 'object' && v !== null && ['outcome', 'check_result'].includes((v as { type?: string }).type ?? '');

export class Learner {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<LearnRun> | null = null;
  private again = false;
  private closed = false;
  private waiters: (() => void)[] = [];
  readonly stats = { runs: 0, changes: 0, lastMs: 0 };

  constructor(private readonly o: LearnerOptions) {}

  /** Something learnable was logged. Debounced: many events in a burst are one derive. */
  notify(): void {
    if (this.closed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runNow();
    }, this.o.debounceMs ?? 5_000);
    this.timer.unref?.();
  }

  get busy(): boolean {
    return this.timer !== undefined || this.running !== null;
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

  /** Derive now (skipping the debounce). Returns what happened. */
  runNow(): Promise<LearnRun> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running) return this.running;
    this.running = this.derive().finally(() => {
      this.running = null;
      if (this.again && !this.closed) {
        this.again = false;
        this.notify();
      } else if (!this.busy) this.waiters.splice(0).forEach((r) => r());
    });
    return this.running;
  }

  private async derive(): Promise<LearnRun> {
    const { state, log } = this.o;
    const holder = state.holder;
    if (state.status !== 'ready' || !holder) return { changed: false, events: 0, ms: 0, version: null, skipped: 'warming' };
    const t0 = performance.now();
    try {
      const [events, contexts] = await Promise.all([readEvents<LogEvent>(this.o.outcomesFile, isEvent), readEvents<ContextRecord>(this.o.contextsFile)]);
      const current = holder.current();
      const doc = deriveWeights(events.events, contexts.events, current.graph, this.o.params ?? DEFAULT_PARAMS);
      const ms = Math.round((performance.now() - t0) * 10) / 10;
      this.stats.runs++;
      this.stats.lastMs = ms;
      // a document that teaches nothing (every outcome failed or was unknown) is not worth saving, unless it replaces something learned
      const teaches = Object.keys(doc.multipliers).length > 0 || doc.addedEdges.length > 0;
      const changed = doc.version !== current.weightsVersion && (teaches || current.weights !== null);
      log.info('learn', { events: doc.events, version: doc.version, changed, ms, corrupt: events.corrupt + contexts.corrupt, truncatedTail: events.truncatedTail });
      if (ms > 1_000) log.warn('deriving weights took over a second: time to make it incremental', { ms, events: doc.events });
      if (!changed) return { changed: false, events: doc.events, ms, version: doc.version };
      await this.apply(doc);
      this.stats.changes++;
      return { changed: true, events: doc.events, ms, version: doc.version };
    } catch (e) {
      log.error('learning failed (the weights stay as they were)', { error: e });
      return { changed: false, events: 0, ms: Math.round(performance.now() - t0), version: null };
    }
  }

  /** Make `doc` the live weights: file (+ previous), the local store, the in-memory graph, and HydraDB (background). */
  async apply(doc: WeightsDoc): Promise<void> {
    await this.o.weights.save(doc);
    await this.o.store.putWeights(doc).catch((e: unknown) => this.o.log.warn('could not store the weights document', { error: e }));
    this.o.state.holder?.swapWeights(doc);
    this.o.sync?.push(doc);
  }

  /** Re-read weights.json (after `click weights --rollback`) and make it live. */
  async reload(): Promise<WeightsDoc | null> {
    const doc = await this.o.weights.load();
    if (!doc) return null;
    this.o.store.putWeights(doc).catch(() => undefined);
    this.o.state.holder?.swapWeights(doc);
    this.o.sync?.push(doc);
    return doc;
  }
}

export interface WeightsSummary {
  version: string | null;
  events: number;
  derivedFrom: string | null;
  multipliers: number;
  learnedEdges: number;
  up: { key: string; w: number }[];
  down: { key: string; w: number }[];
  previous: string | null;
}

export function summarise(doc: WeightsDoc | null, previous: WeightsDoc | null): WeightsSummary {
  const entries = Object.entries(doc?.multipliers ?? {});
  const top = (sign: 1 | -1) =>
    entries
      .filter(([, w]) => (sign === 1 ? w > 1 : w < 1))
      .sort((a, b) => sign * (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
      .slice(0, 8)
      .map(([key, w]) => ({ key, w }));
  return { version: doc?.version ?? null, events: doc?.events ?? 0, derivedFrom: doc?.derivedFrom ?? null, multipliers: entries.length, learnedEdges: doc?.addedEdges.length ?? 0, up: top(1), down: top(-1), previous: previous?.version ?? null };
}

export function weightsRoutes(learner: Learner, file: WeightsFile): Route[] {
  return [
    { method: 'GET', path: '/weights', handle: async () => ({ ok: true, ...summarise(await file.load(), await file.loadPrevious()), learner: learner.stats }) },
    {
      method: 'POST',
      path: '/weights/reload',
      handle: async () => {
        const doc = await learner.reload();
        return { ok: true, version: doc?.version ?? null };
      },
    },
    { method: 'POST', path: '/weights/derive', handle: async () => ({ ok: true, ...(await learner.runNow()) }) },
  ];
}
