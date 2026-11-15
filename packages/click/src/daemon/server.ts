// PROMPTS 110 / SPEC §10, §11.1: the daemon's HTTP server and process lifecycle.
//   node:http on 127.0.0.1:0, a random 32-byte token on every request (x-click-token), a 1 MB body cap, JSON errors
//   `{ ok: false, error: { code, message } }`, request ids, per-request timing logs. Routes are plain data: see routes.ts.
//   startDaemon wires it to the lock + discovery file + signals + idle timeout, so it also cleans up after itself.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ZodError } from 'zod';
import { createLogger, type Logger } from '../../../core/src/util/log.js';
import { acquireLock, daemonPaths, installShutdown, removeInfo, writeInfo, type DaemonInfo } from './lifecycle.js';

export const MAX_BODY_BYTES = 1024 * 1024;
export const TOKEN_HEADER = 'x-click-token';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface RouteCtx {
  id: string;
  query: URLSearchParams;
  /** Parsed JSON body for POST, undefined for GET. */
  body: unknown;
  /** Aborts when the client goes away before the answer is sent. */
  signal: AbortSignal;
}

export interface Route {
  method: 'GET' | 'POST';
  path: string;
  handle(ctx: RouteCtx): Promise<unknown> | unknown;
}

export interface HttpOptions {
  token: string;
  routes: readonly Route[];
  logger?: Logger;
  maxBodyBytes?: number;
  /** Called at the start of every authorised request (resets the idle timer). */
  onActivity?: () => void;
}

export interface HttpHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

const send = (res: ServerResponse, status: number, body: unknown, id: string, extra: Record<string, string> = {}): void => {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'x-click-request-id': id, 'cache-control': 'no-store', ...extra });
  res.end(text);
};
const fail = (res: ServerResponse, status: number, code: string, message: string, id: string, extra?: Record<string, string>): void => send(res, status, { ok: false, error: { code, message } }, id, extra);

function tokenOk(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Reads the body, or rejects with HttpError 413 as soon as it is over the cap (the rest is never buffered). */
function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) return reject(new HttpError(413, 'payload_too_large', `body is larger than ${max} bytes`));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        chunks.length = 0;
        reject(new HttpError(413, 'payload_too_large', `body is larger than ${max} bytes`));
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startHttp(opts: HttpOptions): Promise<HttpHandle> {
  const log = opts.logger;
  const max = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  const table = new Map(opts.routes.map((r) => [`${r.method} ${r.path}`, r]));
  const paths = new Set(opts.routes.map((r) => r.path));
  let seq = 0;
  let port = 0;

  const server = createServer((req, res) => {
    const id = `req_${(++seq).toString(36)}_${randomBytes(3).toString('hex')}`;
    const t0 = performance.now();
    let status = 0;
    const origEnd = res.end.bind(res);
    res.end = ((...a: Parameters<typeof origEnd>) => {
      status = res.statusCode;
      return origEnd(...a);
    }) as typeof res.end;
    res.on('close', () => log?.info('request', { id, method: req.method, path: req.url?.split('?')[0], status, ms: Math.round((performance.now() - t0) * 10) / 10 }));

    void (async () => {
      const host = req.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return fail(res, 403, 'bad_host', 'requests must target the loopback address', id); // DNS-rebinding guard
      if (!tokenOk(req.headers[TOKEN_HEADER], opts.token)) return fail(res, 401, 'unauthorized', `missing or wrong ${TOKEN_HEADER}`, id);
      opts.onActivity?.();

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const route = table.get(`${req.method} ${url.pathname}`);
      if (!route) {
        return paths.has(url.pathname)
          ? fail(res, 405, 'method_not_allowed', `${req.method} is not allowed on ${url.pathname}`, id)
          : fail(res, 404, 'not_found', `no route ${url.pathname}`, id);
      }

      let body: unknown;
      if (route.method === 'POST') {
        let raw: Buffer;
        try {
          raw = await readBody(req, max);
        } catch (e) {
          if (e instanceof HttpError) return fail(res, e.status, e.code, e.message, id, { connection: 'close' });
          throw e;
        }
        try {
          body = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
        } catch {
          return fail(res, 400, 'bad_json', 'body is not valid JSON', id);
        }
      }

      const ctrl = new AbortController();
      res.on('close', () => ctrl.abort());
      try {
        const out = await route.handle({ id, query: url.searchParams, body, signal: ctrl.signal });
        send(res, 200, out, id);
      } catch (e) {
        if (e instanceof HttpError) return fail(res, e.status, e.code, e.message, id);
        if (e instanceof ZodError) return fail(res, 400, 'bad_request', e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), id);
        log?.error('handler failed', { id, path: url.pathname, error: e });
        fail(res, 500, 'internal', 'internal error', id);
      }
    })().catch((e: unknown) => {
      log?.error('request failed', { id, error: e });
      fail(res, 500, 'internal', 'internal error', id);
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;

  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

// ---------------------------------------------------------------- lifecycle

export interface DaemonOptions {
  root: string;
  /** Where daemon.json / daemon.lock live. */
  dir: string;
  routes: readonly Route[];
  version: string;
  /** Idle shutdown, in minutes (SPEC: `daemon.idleMinutes`, default 240). 0 disables. */
  idleMinutes?: number;
  token?: string;
  logger?: Logger;
  /** Run after the HTTP server stops, before the files are removed. */
  onClose?: () => Promise<void>;
  /** Install SIGINT/SIGTERM handlers (default true; tests turn it off). */
  handleSignals?: boolean;
  /** Test hook: idle timer in ms instead of minutes. */
  idleMs?: number;
}

export interface DaemonHandle {
  info: DaemonInfo;
  close(reason?: string): Promise<void>;
  /** Resolves when the daemon has shut down (signal, idle timeout or close()). */
  closed: Promise<string>;
}

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const log = opts.logger ?? createLogger('daemon', { dir: `${opts.dir}/logs` });
  const release = await acquireLock(opts.dir); // throws DaemonLockedError when one is already running
  const token = opts.token ?? randomBytes(32).toString('hex');
  const idleMs = opts.idleMs ?? (opts.idleMinutes ?? 240) * 60_000;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let shutdown: (reason: string) => Promise<void> = async () => undefined;
  const arm = (): void => {
    if (idle) clearTimeout(idle);
    if (idleMs > 0) {
      idle = setTimeout(() => void shutdown('idle'), idleMs);
      idle.unref?.();
    }
  };

  let http: HttpHandle;
  try {
    http = await startHttp({ token, routes: opts.routes, logger: log, onActivity: arm });
  } catch (e) {
    await release();
    throw e;
  }
  const info: DaemonInfo = { v: 1, pid: process.pid, port: http.port, token, startedAt: new Date().toISOString(), version: opts.version, root: opts.root };
  try {
    await writeInfo(opts.dir, info);
  } catch (e) {
    await http.close();
    await release();
    throw e;
  }

  let resolveClosed!: (reason: string) => void;
  const closed = new Promise<string>((r) => (resolveClosed = r));
  let done: Promise<void> | null = null;
  const uninstall = opts.handleSignals === false ? () => undefined : installShutdown((reason) => shutdown(reason));
  const onExit = (): void => void removeInfoSync(opts.dir, info.pid); // last resort when the process dies without our handlers

  shutdown = (reason: string) =>
    (done ??= (async () => {
      if (idle) clearTimeout(idle);
      uninstall();
      process.off('exit', onExit);
      log.info('shutting down', { reason });
      await http.close().catch(() => undefined);
      await opts.onClose?.().catch((e: unknown) => log.error('onClose failed', { error: e }));
      await removeInfo(opts.dir, info.pid).catch(() => undefined);
      await release().catch(() => undefined);
      resolveClosed(reason);
    })());
  process.on('exit', onExit);
  arm();
  log.info('daemon listening', { port: info.port, pid: info.pid, root: opts.root });
  return { info, close: (reason = 'close') => shutdown(reason), closed };
}

function removeInfoSync(dir: string, pid: number): void {
  try {
    const { info, lock } = daemonPaths(dir);
    const parsed = JSON.parse(readFileSync(info, 'utf8')) as Partial<DaemonInfo>;
    if (parsed.pid === pid) rmSync(info, { force: true });
    if (Number.parseInt(readFileSync(lock, 'utf8'), 10) === pid) rmSync(lock, { force: true });
  } catch {
    // already gone
  }
}
