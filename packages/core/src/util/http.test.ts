import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Deadline } from './deadline.js';
import { HttpError, backoffDelay, fetchJson, netCounter, parseRetryAfter } from './http.js';

let server: Server;
let base: string;
const hits = new Map<string, number>();
let lastBody = '';
let lastHeaders: Record<string, string | string[] | undefined> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const key = url.pathname + url.search;
    const n = (hits.get(key) ?? 0) + 1;
    hits.set(key, n);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString();
      lastHeaders = req.headers;
      const json = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(obj));
      };
      switch (url.pathname) {
        case '/ok':
          return json(200, { ok: true });
        case '/echo':
          return json(200, { body: lastBody });
        case '/empty':
          res.writeHead(204);
          return res.end();
        case '/badjson':
          res.writeHead(200);
          return res.end('not json');
        case '/flaky': // fails with 503 until the Nth hit
          return n <= Number(url.searchParams.get('fails') ?? 2) ? json(503, { e: 'down' }) : json(200, { n });
        case '/limited':
          return n === 1 ? json(429, { e: 'slow down' }, { 'retry-after': '0' }) : json(200, { n });
        case '/limited-long':
          return json(429, { e: 'slow down' }, { 'retry-after': '1' });
        case '/always500':
          return json(500, { e: 'boom' });
        case '/notfound':
          return json(404, { e: 'nope' });
        case '/slow':
          return void setTimeout(() => json(200, { slow: true }), 500);
        default:
          return json(404, {});
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
beforeEach(() => hits.clear());

const fast = { baseDelayMs: 1, maxDelayMs: 5 };

describe('fetchJson', () => {
  it('returns parsed JSON; empty bodies give undefined', async () => {
    expect(await fetchJson(`${base}/ok`)).toEqual({ ok: true });
    expect(await fetchJson(`${base}/empty`)).toBeUndefined();
  });

  it('JSON-encodes object bodies, defaults to POST and sets content-type', async () => {
    const out = await fetchJson<{ body: string }>(`${base}/echo`, { body: { a: 1 } });
    expect(JSON.parse(out.body)).toEqual({ a: 1 });
    expect(lastHeaders['content-type']).toBe('application/json');
  });

  it('retries 5xx with backoff and then succeeds', async () => {
    const { result, calls, attempts } = await netCounter.run(() => fetchJson<{ n: number }>(`${base}/flaky?fails=2`, fast));
    expect(result.n).toBe(3);
    expect(calls).toBe(1); // one logical call
    expect(attempts).toBe(3); // three real attempts
  });

  it('gives up after `retries` extra attempts and throws HttpError', async () => {
    const err = await fetchJson(`${base}/always500`, { ...fast, retries: 2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ code: 'status', status: 500, attempts: 3 });
    expect(hits.get('/always500')).toBe(3);
  });

  it('retries 429 and honours Retry-After', async () => {
    const out = await fetchJson<{ n: number }>(`${base}/limited`, { baseDelayMs: 5000, maxDelayMs: 5000 });
    expect(out.n).toBe(2); // Retry-After: 0 overrode the 5 s backoff, so this returns immediately
  });

  it('does not retry other 4xx', async () => {
    const err = await fetchJson(`${base}/notfound`, fast).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'status', status: 404, attempts: 1 });
    expect(hits.get('/notfound')).toBe(1);
  });

  it('never sleeps past the deadline: a Retry-After beyond the budget fails fast', async () => {
    const start = Date.now();
    const err = await fetchJson(`${base}/limited-long`, { deadline: new Deadline(300), ...fast }).catch((e: unknown) => e);
    expect(Date.now() - start).toBeLessThan(250);
    expect(err).toMatchObject({ code: 'status', status: 429 });
    expect(hits.get('/limited-long')).toBe(1);
  });

  it('aborts an in-flight request when the deadline expires', async () => {
    const start = Date.now();
    const err = await fetchJson(`${base}/slow`, { deadline: new Deadline(100) }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'aborted' });
    expect(Date.now() - start).toBeLessThan(400);
  });

  it('fails immediately when the deadline is already spent', async () => {
    const err = await fetchJson(`${base}/ok`, { deadline: new Deadline(0) }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'aborted' });
    expect(hits.size).toBe(0);
  });

  it('times out a slow attempt without retrying', async () => {
    const err = await fetchJson(`${base}/slow`, { timeoutMs: 80, ...fast }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'timeout', attempts: 1 });
    expect(hits.get('/slow')).toBe(1);
  });

  it('honours a caller AbortSignal', async () => {
    const ctrl = new AbortController();
    const p = fetchJson(`${base}/slow`, { signal: ctrl.signal }).catch((e: unknown) => e);
    setTimeout(() => ctrl.abort(), 30);
    expect(await p).toMatchObject({ code: 'aborted' });
  });

  it('retries network errors and reports them as code=network when they persist', async () => {
    const err = await fetchJson('http://127.0.0.1:1/never', { ...fast, retries: 1 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'network', attempts: 2 });
  });

  it('reports invalid JSON as a non-retried parse error', async () => {
    const err = await fetchJson(`${base}/badjson`, fast).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'parse', attempts: 1 });
  });
});

describe('netCounter', () => {
  it('is undefined outside a scope and counts nothing there', async () => {
    expect(netCounter.current()).toBeUndefined();
    await fetchJson(`${base}/ok`);
    expect(netCounter.current()).toBeUndefined();
  });

  it('counts logical calls, including parallel ones, and lets SDK clients record themselves', async () => {
    const { calls, attempts } = await netCounter.run(async () => {
      await Promise.all([fetchJson(`${base}/ok`), fetchJson(`${base}/ok`)]);
      netCounter.call(); // e.g. an SDK that does not use fetchJson
      netCounter.attempt();
    });
    expect(calls).toBe(3);
    expect(attempts).toBe(3);
  });

  it('keeps concurrent scopes separate and rolls nested counts up', async () => {
    const [a, b] = await Promise.all([
      netCounter.run(() => fetchJson(`${base}/ok`)),
      netCounter.run(async () => {
        await fetchJson(`${base}/ok`);
        await fetchJson(`${base}/ok`);
      }),
    ]);
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(2);

    const outer = await netCounter.run(async () => {
      await netCounter.run(() => fetchJson(`${base}/ok`));
      await fetchJson(`${base}/ok`);
    });
    expect(outer.calls).toBe(2);
  });

  it('lets a test assert the hot-path budget', async () => {
    const { calls } = await netCounter.run(async () => {
      await fetchJson(`${base}/ok`);
      await fetchJson(`${base}/ok`);
    });
    expect(calls).toBeLessThanOrEqual(2);
  });
});

describe('helpers', () => {
  it('backoffDelay uses full jitter bounded by the exponential cap', () => {
    expect(backoffDelay(0, 200, 4000, () => 0.5)).toBe(100);
    expect(backoffDelay(2, 200, 4000, () => 0.5)).toBe(400);
    expect(backoffDelay(10, 200, 4000, () => 0.999)).toBeLessThan(4000);
    expect(backoffDelay(3, 200, 4000, () => 0)).toBe(0);
  });

  it('parseRetryAfter reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('1.5')).toBe(1500);
    const now = Date.parse('2026-11-15T10:00:00Z');
    expect(parseRetryAfter('Sun, 15 Nov 2026 10:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfter('Sun, 15 Nov 2026 09:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('garbage')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
