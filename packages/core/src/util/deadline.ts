// PLAN principle 4: every network stage has a time budget. When it runs out we ship what we have.

export class DeadlineError extends Error {
  constructor(message = 'deadline exceeded') {
    super(message);
    this.name = 'DeadlineError';
  }
}

export class Deadline {
  private readonly end: number;
  private ctrl: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly totalMs: number) {
    this.end = Date.now() + Math.max(0, totalMs);
  }

  /** Milliseconds left, never negative. */
  remaining(): number {
    return Math.max(0, this.end - Date.now());
  }

  get expired(): boolean {
    return this.remaining() <= 0;
  }

  /** A sub-deadline starting now. It can never outlive its parent. */
  child(ms: number): Deadline {
    return new Deadline(Math.min(Math.max(0, ms), this.remaining()));
  }

  /** Aborts with a DeadlineError when the deadline passes. Created lazily, so unused deadlines hold no timer. */
  get signal(): AbortSignal {
    if (this.ctrl) return this.ctrl.signal;
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    const left = this.remaining();
    if (left <= 0) {
      ctrl.abort(new DeadlineError());
    } else if (Number.isFinite(left)) {
      this.timer = setTimeout(() => ctrl.abort(new DeadlineError()), left);
      this.timer.unref?.(); // never keep the process alive just for a deadline
    }
    return ctrl.signal;
  }

  /** Stop the abort timer. Call when the guarded work finished early. */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/**
 * Race `promise` against a timer. On timeout, resolve with `onTimeout()` instead.
 * A rejection that arrives after the timeout is swallowed so it can't crash the process.
 */
export function withDeadline<T, F>(promise: Promise<T>, ms: number, onTimeout: () => F | Promise<F>): Promise<T | F> {
  return new Promise<T | F>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(
      () => {
        if (done) return;
        done = true;
        Promise.resolve().then(onTimeout).then(resolve, reject);
      },
      Math.max(0, ms),
    );
    promise.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        if (done) return; // late failure after we already gave up
        done = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Records how long each pipeline stage took (milliseconds, rounded to 0.1). Repeated names accumulate. */
export class Timings {
  private readonly ms = new Map<string, number>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  async time<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const start = this.now();
    try {
      return await fn();
    } finally {
      this.mark(name, this.now() - start);
    }
  }

  mark(name: string, ms: number): void {
    this.ms.set(name, (this.ms.get(name) ?? 0) + ms);
  }

  toJSON(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.ms) out[k] = Math.round(v * 10) / 10;
    return out;
  }
}
