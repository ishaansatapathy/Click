import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { acquireLock, daemonPaths, DaemonLockedError, installShutdown, isPidAlive, readInfo, removeInfo, writeInfo, type DaemonInfo } from './lifecycle.js';
import { HttpError, startDaemon, startHttp, TOKEN_HEADER, type Route } from './server.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'click-daemon-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const info = (over: Partial<DaemonInfo> = {}): DaemonInfo => ({ v: 1, pid: process.pid, port: 1234, token: 't', startedAt: '2026-11-15T10:00:00.000Z', version: '0.0.0', root: dir, ...over });

/** A pid that is certainly dead: spawn a process that exits at once and wait for it. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => child.on('exit', r));
  return child.pid!;
}

const ROUTES: Route[] = [
  { method: 'GET', path: '/ping', handle: () => ({ ok: true, pong: 1 }) },
  { method: 'POST', path: '/echo', handle: ({ body }) => ({ ok: true, body }) },
  { method: 'POST', path: '/zod', handle: ({ body }) => ({ ok: true, n: z.object({ n: z.number() }).parse(body).n }) },
  { method: 'GET', path: '/teapot', handle: () => Promise.reject(new HttpError(418, 'teapot', 'short and stout')) },
  { method: 'GET', path: '/boom', handle: () => Promise.reject(new Error('secret internals')) },
  { method: 'GET', path: '/slow', handle: ({ signal }) => new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))) },
];

describe('lock and discovery (PROMPTS 110)', () => {
  it('writes and reads daemon.json atomically, and rejects malformed files', async () => {
    await writeInfo(dir, info());
    expect(await readInfo(dir)).toEqual(info());
    writeFileSync(daemonPaths(dir).info, '{"v":1,"pid":"x"}');
    expect(await readInfo(dir)).toBeNull();
    writeFileSync(daemonPaths(dir).info, 'not json');
    expect(await readInfo(dir)).toBeNull();
  });

  it('a second daemon cannot take a held lock', async () => {
    const release = await acquireLock(dir);
    await expect(acquireLock(dir)).rejects.toBeInstanceOf(DaemonLockedError);
    await release();
    expect(existsSync(daemonPaths(dir).lock)).toBe(false);
    await (await acquireLock(dir))();
  });

  it('a lock whose pid is dead is stale: removed once, then taken', async () => {
    writeFileSync(daemonPaths(dir).lock, String(await deadPid()));
    const release = await acquireLock(dir);
    expect(readFileSync(daemonPaths(dir).lock, 'utf8')).toBe(String(process.pid));
    await release();
  });

  it('a garbage lock is stale once it is not fresh; a brand new empty one is treated as someone mid-start', async () => {
    writeFileSync(daemonPaths(dir).lock, '');
    await expect(acquireLock(dir)).rejects.toBeInstanceOf(DaemonLockedError);
    const old = new Date(Date.now() - 60_000);
    const { utimesSync } = await import('node:fs');
    utimesSync(daemonPaths(dir).lock, old, old);
    await (await acquireLock(dir))();
  });

  it('release never removes someone else\'s lock; removeInfo never removes someone else\'s file', async () => {
    const release = await acquireLock(dir);
    writeFileSync(daemonPaths(dir).lock, '999999');
    await release();
    expect(existsSync(daemonPaths(dir).lock)).toBe(true);
    await writeInfo(dir, info({ pid: 424242 }));
    await removeInfo(dir, process.pid);
    expect(await readInfo(dir)).not.toBeNull();
    await removeInfo(dir, 424242);
    expect(await readInfo(dir)).toBeNull();
  });

  it('isPidAlive: ours yes, dead no, nonsense no', async () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(await deadPid())).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
  });

  it('installShutdown runs once, a second signal exits at once, and it can be removed', async () => {
    const handlers = new Map<string, (s: NodeJS.Signals) => void>();
    const exits: number[] = [];
    const proc = {
      on: (e: string, h: (s: NodeJS.Signals) => void) => void handlers.set(e, h),
      off: (e: string) => void handlers.delete(e),
      exit: (c?: number) => void exits.push(c ?? 0),
    } as unknown as Pick<NodeJS.Process, 'on' | 'off' | 'exit'>;
    let runs = 0;
    const off = installShutdown(async () => void runs++, proc);
    expect([...handlers.keys()]).toEqual(expect.arrayContaining(['SIGINT', 'SIGTERM']));
    handlers.get('SIGINT')!('SIGINT');
    handlers.get('SIGTERM')!('SIGTERM');
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toBe(1);
    expect(exits).toEqual([1, 0]); // the second signal exits immediately, then the first shutdown finishes
    off();
    expect(handlers.size).toBe(0);
  });
});

describe('HTTP server (PROMPTS 110)', () => {
  async function up(extra: Partial<Parameters<typeof startHttp>[0]> = {}) {
    const h = await startHttp({ token: 'secret', routes: ROUTES, ...extra });
    const call = (path: string, init: RequestInit = {}, token: string | null = 'secret') =>
      fetch(`http://127.0.0.1:${h.port}${path}`, { ...init, headers: { ...(token ? { [TOKEN_HEADER]: token } : {}), 'content-type': 'application/json', ...(init.headers ?? {}) } });
    return { h, call };
  }

  it('binds to loopback on a random port and serves GET and POST with a request id', async () => {
    const { h, call } = await up();
    try {
      expect(h.port).toBeGreaterThan(0);
      const r = await call('/ping');
      expect(r.status).toBe(200);
      expect(r.headers.get('x-click-request-id')).toMatch(/^req_/);
      expect(await r.json()).toEqual({ ok: true, pong: 1 });
      const e = await call('/echo', { method: 'POST', body: JSON.stringify({ a: [1, 2] }) });
      expect(await e.json()).toEqual({ ok: true, body: { a: [1, 2] } });
      expect(await (await call('/echo', { method: 'POST' })).json()).toEqual({ ok: true, body: {} }); // empty body → {}
    } finally {
      await h.close();
    }
  });

  it('401 without the right token, before anything else', async () => {
    const { h, call } = await up();
    try {
      for (const tok of [null, 'wrong', 'secre', 'secrett']) {
        const r = await call('/ping', {}, tok);
        expect(r.status).toBe(401);
        expect(await r.json()).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
      }
      expect((await call('/nope', {}, null)).status).toBe(401); // unknown paths are not revealed either
    } finally {
      await h.close();
    }
  });

  it('refuses a Host header that is not loopback (DNS rebinding)', async () => {
    const { h } = await up();
    try {
      const r = await new Promise<number>((resolve, reject) => {
        import('node:http').then(({ request }) => {
          const req = request({ host: '127.0.0.1', port: h.port, path: '/ping', headers: { host: 'evil.example.com', [TOKEN_HEADER]: 'secret' } }, (res) => resolve(res.statusCode!));
          req.on('error', reject);
          req.end();
        }, reject);
      });
      expect(r).toBe(403);
    } finally {
      await h.close();
    }
  });

  it('404 for unknown paths, 405 for the wrong method, 400 for invalid JSON', async () => {
    const { h, call } = await up();
    try {
      expect(((await (await call('/nope')).json()) as { error: { code: string } }).error.code).toBe('not_found');
      expect((await call('/ping', { method: 'POST', body: '{}' })).status).toBe(405);
      const bad = await call('/echo', { method: 'POST', body: '{nope' });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: { code: 'bad_json' } });
    } finally {
      await h.close();
    }
  });

  it('413 for a body over the cap (declared or streamed) and the server stays healthy', async () => {
    const { h, call } = await up({ maxBodyBytes: 1000 });
    try {
      const big = await call('/echo', { method: 'POST', body: JSON.stringify({ x: 'a'.repeat(5000) }) });
      expect(big.status).toBe(413);
      expect(await big.json()).toMatchObject({ error: { code: 'payload_too_large' } });
      expect((await call('/echo', { method: 'POST', body: JSON.stringify({ x: 'ok' }) })).status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it('the default cap is 1 MB', async () => {
    const { h, call } = await up();
    try {
      expect((await call('/echo', { method: 'POST', body: JSON.stringify({ x: 'a'.repeat(900_000) }) })).status).toBe(200);
      expect((await call('/echo', { method: 'POST', body: JSON.stringify({ x: 'a'.repeat(1_100_000) }) })).status).toBe(413);
    } finally {
      await h.close();
    }
  });

  it('maps errors: HttpError keeps its status, zod becomes 400, anything else is a generic 500 that leaks nothing', async () => {
    const { h, call } = await up();
    try {
      const t = await call('/teapot');
      expect(t.status).toBe(418);
      expect(await t.json()).toEqual({ ok: false, error: { code: 'teapot', message: 'short and stout' } });
      const z = await call('/zod', { method: 'POST', body: JSON.stringify({ n: 'x' }) });
      expect(z.status).toBe(400);
      expect(((await z.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: 'bad_request', message: expect.stringContaining('n:') });
      const b = await call('/boom');
      expect(b.status).toBe(500);
      expect(JSON.stringify(await b.json())).not.toContain('secret internals');
    } finally {
      await h.close();
    }
  });

  it('a client that goes away aborts the handler\'s signal', async () => {
    let aborted: () => void = () => undefined;
    const seen = new Promise<void>((r) => (aborted = r));
    const { h } = await up({ routes: [{ method: 'GET', path: '/wait', handle: ({ signal }) => new Promise(() => signal.addEventListener('abort', () => aborted())) }] });
    try {
      const ctrl = new AbortController();
      const p = fetch(`http://127.0.0.1:${h.port}/wait`, { headers: { [TOKEN_HEADER]: 'secret' }, signal: ctrl.signal }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 50));
      ctrl.abort();
      await p;
      await Promise.race([seen, new Promise((_r, rej) => setTimeout(() => rej(new Error('handler was not told')), 2000))]);
    } finally {
      await h.close();
    }
  });

  it('every authorised request calls onActivity', async () => {
    let n = 0;
    const { h, call } = await up({ onActivity: () => void n++ });
    try {
      await call('/ping');
      await call('/nope');
      await call('/ping', {}, 'bad');
      expect(n).toBe(2);
    } finally {
      await h.close();
    }
  });
});

describe('startDaemon (PROMPTS 110)', () => {
  const opts = (over: Record<string, unknown> = {}) => ({ root: dir, dir: join(dir, '.click'), routes: ROUTES, version: '9.9.9', handleSignals: false, idleMinutes: 0, ...over });

  it('writes daemon.json (pid, port, 64-hex token) and the lock, serves requests with that token, and cleans up on close', async () => {
    const d = await startDaemon(opts());
    const files = daemonPaths(join(dir, '.click'));
    const disk = await readInfo(join(dir, '.click'));
    expect(disk).toEqual(d.info);
    expect(d.info).toMatchObject({ v: 1, pid: process.pid, version: '9.9.9', root: dir });
    expect(d.info.token).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(files.lock)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${d.info.port}/ping`, { headers: { [TOKEN_HEADER]: d.info.token } })).status).toBe(200);
    await d.close();
    expect(await d.closed).toBe('close');
    expect(existsSync(files.info)).toBe(false);
    expect(existsSync(files.lock)).toBe(false);
    await expect(fetch(`http://127.0.0.1:${d.info.port}/ping`, { headers: { [TOKEN_HEADER]: d.info.token } })).rejects.toThrow();
  });

  it('refuses to start twice for one repo, and recovers from a crashed daemon\'s leftovers', async () => {
    const first = await startDaemon(opts());
    await expect(startDaemon(opts())).rejects.toBeInstanceOf(DaemonLockedError);
    await first.close();

    mkdirSync(join(dir, '.click'), { recursive: true });
    writeFileSync(daemonPaths(join(dir, '.click')).lock, String(await deadPid()));
    writeFileSync(daemonPaths(join(dir, '.click')).info, JSON.stringify(info({ pid: 1 })));
    const second = await startDaemon(opts());
    expect((await readInfo(join(dir, '.click')))!.pid).toBe(process.pid);
    await second.close();
  });

  it('shuts itself down when idle, and activity postpones that', async () => {
    const d = await startDaemon(opts({ idleMs: 1_200 }));
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 350));
      await fetch(`http://127.0.0.1:${d.info.port}/ping`, { headers: { [TOKEN_HEADER]: d.info.token } });
    }
    expect(existsSync(daemonPaths(join(dir, '.click')).info)).toBe(true); // about 1 s of life against a 1.2 s idle limit: only the traffic kept it alive
    expect(await d.closed).toBe('idle');
    expect(existsSync(daemonPaths(join(dir, '.click')).info)).toBe(false);
    expect(existsSync(daemonPaths(join(dir, '.click')).lock)).toBe(false);
  });

  it('close is idempotent and runs onClose once; a failing onClose still cleans up', async () => {
    let closes = 0;
    const d = await startDaemon(opts({ onClose: async () => { closes++; throw new Error('flush failed'); } }));
    await Promise.all([d.close(), d.close(), d.close()]);
    expect(closes).toBe(1);
    expect(existsSync(daemonPaths(join(dir, '.click')).lock)).toBe(false);
  });
});
