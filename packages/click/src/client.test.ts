import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClickClient, ClientError, defaultCliPath, type ClientOptions } from './client.js';
import { daemonPaths, writeInfo } from './daemon/lifecycle.js';
import { startHttp, type HttpHandle, type Route } from './daemon/server.js';

let root: string;
let dir: string;
const handles: HttpHandle[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'click-client-'));
  dir = join(root, '.click');
});
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
  rmSync(root, { recursive: true, force: true });
});

const TOKEN = 'tok-123';
let seen: { path: string; token: string | undefined }[] = [];
/** A fake daemon that records who called it. */
async function fakeDaemon(routes: Route[] = []): Promise<HttpHandle> {
  seen = [];
  const base: Route[] = [
    { method: 'GET', path: '/health', handle: () => ({ ok: true, status: 'ready', version: '0.0.0', graphVersion: 'g1', nodes: 3, edges: 2 }) },
    { method: 'POST', path: '/context', handle: ({ body }) => ({ text: `ctx for ${(body as { task: string }).task}`, tokens: 5 }) },
    { method: 'GET', path: '/slow', handle: () => new Promise((r) => setTimeout(() => r({ ok: true }), 2_000)) },
    { method: 'GET', path: '/boom', handle: () => Promise.reject(new Error('x')) },
  ];
  const h = await startHttp({ token: TOKEN, routes: [...base, ...routes] });
  handles.push(h);
  return h;
}
const publish = (h: HttpHandle, over: Partial<Parameters<typeof writeInfo>[1]> = {}) =>
  writeInfo(dir, { v: 1, pid: process.pid, port: h.port, token: TOKEN, startedAt: '2026-11-15T10:00:00.000Z', version: '0.0.0', root, ...over });

function client(over: Partial<ClientOptions> = {}) {
  const spawns: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const c = new ClickClient({
    root,
    cliPath: '/fake/click.js',
    spawnFn: (cmd, args, opts) => {
      spawns.push({ cmd, args, opts: opts as Record<string, unknown> });
      return { unref: () => undefined };
    },
    ...over,
  });
  return { c, spawns };
}

describe('ClickClient hook mode (PROMPTS 114)', () => {
  it('discovers the daemon, checks health, calls the endpoint and returns the body', async () => {
    const h = await fakeDaemon();
    await publish(h);
    const { c, spawns } = client();
    const out = await c.tryRequest<{ text: string }>('/context', { body: { task: 'add a loading state' }, deadlineMs: 1500 });
    expect(out).toEqual({ text: 'ctx for add a loading state', tokens: 5 });
    expect(spawns).toHaveLength(0);
  });

  it('no daemon.json: returns null at once and starts a daemon in the background (detached, hidden, with --root)', async () => {
    const { c, spawns } = client();
    const t0 = Date.now();
    expect(await c.tryRequest('/context', { body: { task: 'x' }, deadlineMs: 1500 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.cmd).toBe(process.execPath);
    expect(spawns[0]!.args).toEqual(['/fake/click.js', 'serve', '--root', root]);
    expect(spawns[0]!.opts).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true, cwd: root });
  });

  it('a daemon.json whose pid is dead is stale: no request is made (the token goes nowhere) and a daemon is started', async () => {
    const h = await fakeDaemon();
    await publish(h, { pid: 2_147_483_000 });
    const { c, spawns } = client();
    expect(await c.tryRequest('/context', { body: { task: 'x' }, deadlineMs: 1500 })).toBeNull();
    expect(seen).toEqual([]);
    expect(spawns).toHaveLength(1);
  });

  it('several clients that all find no daemon start exactly one', async () => {
    const spawns: unknown[] = [];
    const make = () => new ClickClient({ root, cliPath: '/x', spawnFn: () => (spawns.push(1), { unref: () => undefined }) });
    await Promise.all(Array.from({ length: 8 }, () => make().tryRequest('/context', { body: { task: 'x' }, deadlineMs: 500 })));
    expect(spawns).toHaveLength(1);
    expect(existsSync(join(dir, 'autostart.lock'))).toBe(true);
  });

  it('an old autostart lock (a daemon that never came up) is replaced after its TTL', async () => {
    const { c, spawns } = client();
    await c.tryRequest('/context', { body: { task: 'x' }, deadlineMs: 500 });
    const lock = join(dir, 'autostart.lock');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    await c.tryRequest('/context', { body: { task: 'x' }, deadlineMs: 500 });
    expect(spawns).toHaveLength(2);
  });

  it('a daemon that is alive but slow to answer /health is skipped after the health timeout, without spawning another', async () => {
    const h = await fakeDaemon();
    await publish(h);
    const { c, spawns } = client({ fetchFn: ((url: string, init: RequestInit) => (String(url).endsWith('/health') ? new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason))) : fetch(url, init))) as typeof fetch });
    const t0 = Date.now();
    expect(await c.tryRequest('/context', { body: { task: 'x' }, deadlineMs: 1500 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(600);
    expect(spawns).toHaveLength(0);
  });

  it('the whole call respects the caller\'s deadline', async () => {
    const h = await fakeDaemon();
    await publish(h);
    const { c } = client();
    const t0 = Date.now();
    expect(await c.tryRequest('/slow', { deadlineMs: 400 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(900);
  });

  it('wrong token, server errors, unknown paths and non-JSON all give null, never a throw', async () => {
    const h = await fakeDaemon();
    await publish(h, { token: 'wrong' });
    expect(await client().c.tryRequest('/context', { body: { task: 'x' }, deadlineMs: 1000 })).toBeNull();
    await publish(h);
    const { c } = client();
    expect(await c.tryRequest('/boom', { deadlineMs: 1000 })).toBeNull();
    expect(await c.tryRequest('/nope', { deadlineMs: 1000 })).toBeNull();
    const garbage = await startHttp({ token: TOKEN, routes: [] });
    handles.push(garbage);
    garbage.server.removeAllListeners('request');
    garbage.server.on('request', (_q, res) => void res.end('<html>not json</html>'));
    await publish(garbage);
    expect(await c.tryRequest('/health', { deadlineMs: 1000 })).toBeNull();
  });

  it('never throws even when spawning explodes or the .click directory is unusable', async () => {
    writeFileSync(dir.replace('.click', 'blocker'), 'x');
    const c = new ClickClient({ root, dir: join(root, 'blocker', 'nested'), cliPath: '/x', spawnFn: () => { throw new Error('EACCES'); } });
    expect(await c.tryRequest('/context', { body: { task: 'x' }, deadlineMs: 500 })).toBeNull();
    const d = new ClickClient({ root, cliPath: '/x', spawnFn: () => { throw new Error('EACCES'); } });
    expect(await d.tryRequest('/context', { body: { task: 'x' }, deadlineMs: 500 })).toBeNull();
  });
});

describe('ClickClient CLI mode (PROMPTS 114)', () => {
  it('request() returns the body, or throws a ClientError that says what went wrong', async () => {
    const h = await fakeDaemon();
    const { c } = client();
    await expect(c.request('/health', { deadlineMs: 500 })).rejects.toMatchObject({ code: 'no_daemon' });
    await publish(h);
    expect(await c.request<{ graphVersion: string }>('/health', { deadlineMs: 500 })).toMatchObject({ graphVersion: 'g1' });
    await expect(c.request('/nope', { deadlineMs: 500 })).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(c.request('/slow', { deadlineMs: 200 })).rejects.toMatchObject({ code: 'timeout' });
    await publish(h, { token: 'bad' });
    await expect(c.request('/health', { deadlineMs: 500 })).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    await expect(c.request('/health', { deadlineMs: 500 })).rejects.toBeInstanceOf(ClientError);
  });

  it('ensureRunning waits for a daemon that appears, and starts one only once', async () => {
    const h = await fakeDaemon();
    const { c, spawns } = client();
    setTimeout(() => void publish(h), 300); // "the spawned daemon comes up"
    const info = await c.ensureRunning({ waitMs: 3_000 });
    expect(info.port).toBe(h.port);
    expect(spawns).toHaveLength(1);
  });

  it('ensureRunning({ ready }) waits for the graph to load; and gives up with a helpful message', async () => {
    let status = 'warming';
    const h = await fakeDaemon();
    h.server.removeAllListeners('request');
    h.server.on('request', (_q, res) => (res.setHeader('content-type', 'application/json'), res.end(JSON.stringify({ ok: true, status, version: '0', graphVersion: null, nodes: 0, edges: 0 }))));
    await publish(h);
    const { c } = client();
    setTimeout(() => (status = 'ready'), 300);
    await c.ensureRunning({ waitMs: 3_000, ready: true });
    status = 'warming';
    await expect(c.ensureRunning({ waitMs: 400, ready: true })).rejects.toMatchObject({ code: 'start_timeout', message: expect.stringContaining('logs') });
  });
});

describe('defaultCliPath', () => {
  it('prefers CLICK_CLI, then click.js beside the file, then one level up (hooks live in dist/hooks)', () => {
    const prev = process.env.CLICK_CLI;
    process.env.CLICK_CLI = '/custom/click.js';
    expect(defaultCliPath()).toBe('/custom/click.js');
    delete process.env.CLICK_CLI;
    writeFileSync(join(root, 'click.js'), '');
    expect(defaultCliPath(root)).toBe(join(root, 'click.js'));
    expect(defaultCliPath(join(root, 'hooks'))).toBe(join(root, 'hooks', '..', 'click.js'));
    if (prev !== undefined) process.env.CLICK_CLI = prev;
    expect(existsSync(daemonPaths(dir).info)).toBe(false);
  });
});
