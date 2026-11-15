// PROMPTS 112 / SPEC §17.3: `.click/stats.json`, what `click status` and the status line read.
//   { last: { contextId, tokens, files, ms, pruner, degraded, ts } | null, session: { <id>: { contexts, tokens } }, totals: { contexts, tokens } }
// Kept in memory, written atomically after every context. A bad or missing file just means we start from zero.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../../../core/src/util/atomic.js';
import type { Logger } from '../../../core/src/util/log.js';
import type { PackedContext } from '../../../core/src/types.js';
import { MAX_SESSIONS } from './sessions.js';

const MIN_WRITE_GAP_MS = 1_000;

export interface Stats {
  last: { contextId: string; tokens: number; files: number; ms: number; pruner: string; degraded: string[]; ts: string } | null;
  session: Record<string, { contexts: number; tokens: number }>;
  totals: { contexts: number; tokens: number };
}

export class StatsKeeper {
  private stats: Stats = { last: null, session: {}, totals: { contexts: 0, tokens: 0 } };
  private writing: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastWrite = Number.NEGATIVE_INFINITY;
  private readonly file: string;

  constructor(
    dir: string,
    private readonly log?: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.file = join(dir, 'stats.json');
    try {
      const o = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Stats>;
      if (o && typeof o === 'object' && o.totals && typeof o.totals.contexts === 'number') this.stats = { last: o.last ?? null, session: o.session ?? {}, totals: o.totals };
    } catch {
      // first run, or unreadable: start from zero
    }
  }

  get(): Stats {
    return structuredClone(this.stats);
  }

  record(packed: PackedContext, sessionId: string | undefined, ms: number): void {
    const s = this.stats;
    s.last = {
      contextId: packed.contextId,
      tokens: packed.tokens,
      files: new Set(packed.items.flatMap((i) => (i.path ? [i.path] : []))).size,
      ms: Math.round(ms),
      pruner: packed.pruner,
      degraded: packed.degraded,
      ts: new Date(this.now()).toISOString(),
    };
    s.totals.contexts++;
    s.totals.tokens += packed.tokens;
    if (sessionId) {
      const cur = s.session[sessionId] ?? { contexts: 0, tokens: 0 };
      delete s.session[sessionId]; // re-insert last so the oldest sessions are the first keys
      s.session[sessionId] = { contexts: cur.contexts + 1, tokens: cur.tokens + packed.tokens };
      const keys = Object.keys(s.session);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete s.session[k];
    }
    this.scheduleWrite();
  }

  /** At most one write per second (SPEC §17.3): a burst of contexts becomes one file write, and the newest numbers always win. */
  private scheduleWrite(): void {
    if (this.timer) return; // a write is already scheduled: it will take the latest state
    const wait = Math.max(0, MIN_WRITE_GAP_MS - (this.now() - this.lastWrite));
    if (wait === 0) {
      this.writeNow();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.writeNow();
    }, wait);
    this.timer.unref?.();
  }

  private writeNow(): void {
    this.lastWrite = this.now();
    const snapshot = JSON.stringify(this.stats);
    this.writing = this.writing.then(() => writeFileAtomic(this.file, snapshot)).catch((e: unknown) => this.log?.warn('could not write stats.json', { error: e }));
  }

  /** Write anything still waiting, then wait for pending writes (tests, shutdown). */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.writeNow();
    }
    return this.writing;
  }
}
