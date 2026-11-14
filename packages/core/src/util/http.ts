import { AsyncLocalStorage } from 'node:async_hooks';
import type { Deadline } from './deadline.js';

// Every outbound call goes through fetchJson: one place for timeouts, deadlines, retries, and the
// network-call counter that tests use to assert the hot-path budget (at most 2 calls, SPEC §18.1).

// ---------------------------------------------------------------- netCounter

export interface NetCounts {
  /** Logical calls: one per fetchJson() (or one per netCounter.call() for non-fetch clients). Retries do not add. */
  calls: number;
  /** Real HTTP attempts, retries included. */
  attempts: number;
}

const scope = new AsyncLocalStorage<NetCounts>();

export const netCounter = {
  /** Run `fn` in a counting scope. Counts also roll up into an enclosing scope. */
  async run<T>(fn: () => Promise<T>): Promise<{ result: T } & NetCounts> {
    const counts: NetCounts = { calls: 0, attempts: 0 };
    const parent = scope.getStore();
    try {
      const result = await scope.run(counts, fn);
      return { result, ...counts };
    } finally {
      if (parent) {
        parent.calls += counts.calls;
        parent.attempts += counts.attempts;
      }
    }
  },
  /** Counts so far in the current scope, or undefined outside any scope. */
  current(): NetCounts | undefined {
    const s = scope.getStore();
    return s ? { ...s } : undefined;
  },
  /** Record one logical call. SDK-based clients that bypass fetchJson must call this themselves. */
  call(): void {
    const s = scope.getStore();
    if (s) s.calls++;
  },
  attempt(): void {
    const s = scope.getStore();
    if (s) s.attempts++;
  },
};

// ---------------------------------------------------------------- errors

export type HttpErrorCode = 'status' | 'network' | 'timeout' | 'aborted' | 'parse';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly code: HttpErrorCode,
    readonly url: string,
    readonly attempts: number,
    readonly status?: number,
    readonly body?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HttpError';
  }
}

// ---------------------------------------------------------------- retry helpers

/** Full jitter: a random delay in [0, min(max, base * 2^attempt)). `attempt` counts from 0. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  return Math.floor(random() * Math.min(maxMs, baseMs * 2 ** attempt));
}

/** Retry-After as milliseconds. Accepts delta-seconds or an HTTP date. */
export function parseRetryAfter(header: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (header === null || header === undefined || header.trim() === '') return undefined;
  const h = header.trim();
  if (/^\d+(\.\d+)?$/.test(h)) return Math.round(Number(h) * 1000);
  const t = Date.parse(h);
  return Number.isNaN(t) ? undefined : Math.max(0, t - nowMs);
}

function sleep(ms: number, signal: AbortSignal | undefined, url: string, attempts: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new HttpError('aborted while waiting to retry', 'aborted', url, attempts));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new HttpError('aborted while waiting to retry', 'aborted', url, attempts));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------- fetchJson

export interface FetchJsonOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Objects are JSON-encoded (content-type is set for you); strings are sent as-is. */
  body?: unknown;
  signal?: AbortSignal;
  /** Per-attempt timeout. Not retried. */
  timeoutMs?: number;
  /** Overall budget. We never start an attempt, or sleep before one, that would run past it. */
  deadline?: Deadline;
  /** Extra attempts after the first (default 3). Retries: 429, 5xx and network errors. */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Longest Retry-After we are willing to wait for (default 30 s). */
  maxRetryAfterMs?: number;
  random?: () => number;
  fetch?: typeof fetch;
}

type Attempt<T> =
  | { ok: true; value: T }
  | { ok: false; err: HttpError; retryable: boolean; retryAfterMs?: number | undefined };

export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const {
    method = opts.body === undefined ? 'GET' : 'POST',
    retries = 3,
    baseDelayMs = 200,
    maxDelayMs = 4000,
    maxRetryAfterMs = 30_000,
    random = Math.random,
    deadline,
    timeoutMs,
  } = opts;
  const doFetch = opts.fetch ?? globalThis.fetch;

  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  let body: string | undefined;
  if (opts.body !== undefined) {
    if (typeof opts.body === 'string') body = opts.body;
    else {
      body = JSON.stringify(opts.body);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
    }
  }

  netCounter.call();

  for (let attempt = 1; ; attempt++) {
    if (deadline?.expired || opts.signal?.aborted) {
      throw new HttpError('deadline exceeded before request', 'aborted', url, attempt - 1);
    }
    netCounter.attempt();

    const timeoutSignal = timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined;
    const signals = [opts.signal, deadline?.signal, timeoutSignal].filter((s): s is AbortSignal => s !== undefined);
    const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;

    const result = await attemptOnce<T>(doFetch, url, { method, headers, body, signal }, attempt, timeoutSignal);
    if (result.ok) return result.value;

    const { err, retryable, retryAfterMs } = result;
    if (!retryable || attempt > retries) throw err;

    const wait = retryAfterMs ?? backoffDelay(attempt - 1, baseDelayMs, maxDelayMs, random);
    if (wait > maxRetryAfterMs) throw err;
    if (deadline && wait >= deadline.remaining()) throw err; // would blow the budget: give up now, don't sleep
    await sleep(wait, AbortSignal.any([opts.signal, deadline?.signal].filter((s): s is AbortSignal => s !== undefined)), url, attempt);
  }
}

async function attemptOnce<T>(
  doFetch: typeof fetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string | undefined; signal: AbortSignal | undefined },
  attempt: number,
  timeoutSignal: AbortSignal | undefined,
): Promise<Attempt<T>> {
  try {
    const req: RequestInit = { method: init.method, headers: init.headers };
    if (init.body !== undefined) req.body = init.body;
    if (init.signal) req.signal = init.signal;
    const res = await doFetch(url, req);
    const text = await res.text();

    if (res.ok) {
      if (text === '') return { ok: true, value: undefined as T };
      try {
        return { ok: true, value: JSON.parse(text) as T };
      } catch (cause) {
        return { ok: false, retryable: false, err: new HttpError('invalid JSON in response', 'parse', url, attempt, res.status, text.slice(0, 200), { cause }) };
      }
    }
    return {
      ok: false,
      retryable: res.status === 429 || res.status >= 500,
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
      err: new HttpError(`HTTP ${res.status}`, 'status', url, attempt, res.status, text.slice(0, 500)),
    };
  } catch (cause) {
    if (timeoutSignal?.aborted) {
      return { ok: false, retryable: false, err: new HttpError('request timed out', 'timeout', url, attempt, undefined, undefined, { cause }) };
    }
    if (init.signal?.aborted) {
      return { ok: false, retryable: false, err: new HttpError('request aborted', 'aborted', url, attempt, undefined, undefined, { cause }) };
    }
    return { ok: false, retryable: true, err: new HttpError('network error', 'network', url, attempt, undefined, undefined, { cause }) };
  }
}
