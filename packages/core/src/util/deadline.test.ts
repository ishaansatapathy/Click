import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Deadline, DeadlineError, Timings, withDeadline } from './deadline.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Deadline', () => {
  it('counts down and expires', () => {
    const d = new Deadline(1000);
    expect(d.remaining()).toBe(1000);
    expect(d.expired).toBe(false);
    vi.advanceTimersByTime(400);
    expect(d.remaining()).toBe(600);
    vi.advanceTimersByTime(700);
    expect(d.remaining()).toBe(0); // never negative
    expect(d.expired).toBe(true);
  });

  it('child deadlines are capped by what the parent has left', () => {
    const parent = new Deadline(1000);
    vi.advanceTimersByTime(700); // 300 left
    const child = parent.child(500);
    expect(child.remaining()).toBe(300);
    expect(parent.child(100).remaining()).toBe(100);
  });

  it('nests: grandchild is bounded by the whole chain', () => {
    const root = new Deadline(1200);
    const mid = root.child(500);
    vi.advanceTimersByTime(400); // root 800, mid 100
    const leaf = mid.child(400);
    expect(leaf.remaining()).toBe(100);
    vi.advanceTimersByTime(100);
    expect(mid.expired).toBe(true);
    expect(leaf.expired).toBe(true);
    expect(root.expired).toBe(false);
  });

  it('a child of an expired deadline is already expired', () => {
    const d = new Deadline(10);
    vi.advanceTimersByTime(50);
    expect(d.child(1000).expired).toBe(true);
  });

  it('signal aborts with a DeadlineError when time runs out', () => {
    const d = new Deadline(500);
    const { signal } = d;
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(499);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(DeadlineError);
  });

  it('signal of an already-expired deadline is already aborted', () => {
    const d = new Deadline(0);
    expect(d.signal.aborted).toBe(true);
  });

  it('a child signal fires at the parent limit even if the child asked for longer', () => {
    const parent = new Deadline(200);
    const child = parent.child(5000);
    const { signal } = child;
    vi.advanceTimersByTime(200);
    expect(signal.aborted).toBe(true);
  });

  it('dispose stops the timer', () => {
    const d = new Deadline(100);
    const { signal } = d;
    d.dispose();
    vi.advanceTimersByTime(1000);
    expect(signal.aborted).toBe(false);
  });

  it('an infinite deadline never fires', () => {
    const d = new Deadline(Infinity);
    const { signal } = d;
    vi.advanceTimersByTime(1e9);
    expect(signal.aborted).toBe(false);
    expect(d.expired).toBe(false);
  });
});

describe('withDeadline', () => {
  it('returns the value when the promise wins', async () => {
    const p = withDeadline(Promise.resolve('real'), 100, () => 'fallback');
    await expect(p).resolves.toBe('real');
  });

  it('returns the fallback when the timer wins', async () => {
    const slow = new Promise<string>((r) => setTimeout(() => r('late'), 500));
    const p = withDeadline(slow, 100, () => 'fallback');
    vi.advanceTimersByTime(100);
    await expect(p).resolves.toBe('fallback');
  });

  it('supports an async fallback', async () => {
    const p = withDeadline(new Promise<string>(() => {}), 50, async () => 'async-fallback');
    vi.advanceTimersByTime(50);
    await expect(p).resolves.toBe('async-fallback');
  });

  it('propagates a rejection that happens before the timeout', async () => {
    const p = withDeadline(Promise.reject(new Error('boom')), 100, () => 'fallback');
    await expect(p).rejects.toThrow('boom');
  });

  it('swallows a rejection that arrives after the timeout', async () => {
    const lateFail = new Promise<string>((_, rej) => setTimeout(() => rej(new Error('late boom')), 300));
    const p = withDeadline(lateFail, 100, () => 'fallback');
    vi.advanceTimersByTime(100);
    await expect(p).resolves.toBe('fallback');
    vi.advanceTimersByTime(300); // the late rejection fires; it must not become an unhandled rejection
    await Promise.resolve();
  });
});

describe('Timings', () => {
  function clock(): { now: () => number; tick: (ms: number) => void } {
    let t = 0;
    return { now: () => t, tick: (ms) => (t += ms) };
  }

  it('records stage durations rounded to 0.1 ms', async () => {
    const c = clock();
    const t = new Timings(c.now);
    const out = await t.time('ppr', async () => {
      c.tick(12.34);
      return 'x';
    });
    expect(out).toBe('x');
    expect(t.toJSON()).toEqual({ ppr: 12.3 });
  });

  it('accumulates repeated names and keeps stages separate', async () => {
    const c = clock();
    const t = new Timings(c.now);
    await t.time('io', () => c.tick(5));
    await t.time('io', () => c.tick(7));
    await t.time('pack', () => c.tick(1));
    expect(t.toJSON()).toEqual({ io: 12, pack: 1 });
  });

  it('records the time even when the stage throws, and rethrows', async () => {
    const c = clock();
    const t = new Timings(c.now);
    await expect(
      t.time('semantic', () => {
        c.tick(400);
        throw new Error('timeout');
      }),
    ).rejects.toThrow('timeout');
    expect(t.toJSON()).toEqual({ semantic: 400 });
  });

  it('mark adds externally measured values', () => {
    const t = new Timings();
    t.mark('total', 99.96);
    expect(t.toJSON()).toEqual({ total: 100 });
  });
});
