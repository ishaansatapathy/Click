// PROMPTS 114 / SPEC §11.2: how the hook, the CLI and the MCP server talk to the per-repo daemon.
//   1. read .click/daemon.json; missing or its pid is dead  -> start a daemon in the background, answer "not yet" (null)
//   2. GET /health within 150 ms; the token is only ever sent to a process that is really the daemon's pid
//   3. make the call within what is left of the caller's deadline
// `tryRequest` is the hook mode: it never throws and returns null on any problem, so a broken Click can only ever mean "no extra
// context", never a broken agent. `request` / `ensureRunning` are the CLI mode: they throw ClientError with a message to show.
// Starting is guarded by a lock file so several clients that find no daemon at the same moment spawn only one.

import type { SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickDir } from '../../core/src/util/paths.js';
import { isPidAlive, readInfo, type DaemonInfo } from './daemon/lifecycle.js';

export const TOKEN_HEADER = 'x-click-token';
export const HEALTH_TIMEOUT_MS = 150;
const AUTOSTART_LOCK = 'autostart.lock';
const AUTOSTART_LOCK_TTL_MS = 15_000;

/**
 * One plain HTTP/1.1 request on a socket of its own, closed afterwards. Not fetch: undici keeps connections alive for seconds, which
 * would hold a short-lived hook process open (and ending it with process.exit while sockets close crashes node on Windows).
 */
async function nodeRequest(port: number, path: string, method: string, headers: Record<string, string>, body: string | undefined, signal: AbortSignal): Promise<{ status: number; text: string }> {
  const { request: httpRequest } = await import('node:http'); // loaded only when a request is really made: a skipped hook never pays for it
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, agent: false, signal, headers: { ...headers, connection: 'close', ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** CLICK_DEBUG=1 explains on STDERR (never stdout: hooks speak JSON there) why a hook-mode call came back empty. */
function debug(what: string, e: unknown): void {
  if (process.env.CLICK_DEBUG) process.stderr.write(`click client: ${what}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}
`);
}

export class ClientError extends Error {
  constructor(
    message: string,
    readonly code: string = 'client_error',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ClientError';
  }
}

export interface ClientOptions {
  root: string;
  /** Where daemon.json lives. Default: clickDir(root). */
  dir?: string;
  /** The CLI entry used to start the daemon: `node <cliPath> serve`. */
  cliPath?: string;
  spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => { unref(): void };
  fetchFn?: typeof fetch;
  healthTimeoutMs?: number;
}

export interface HealthBody {
  ok: boolean;
  status: 'warming' | 'ready';
  version: string;
  graphVersion: string | null;
  nodes: number;
  edges: number;
  [k: string]: unknown;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Total time for the whole call, discovery and health check included. */
  deadlineMs: number;
}

/** Where the CLI lives next to this file: dist/click.js, whether we run from dist/click.js or dist/hooks/*.js. */
export function defaultCliPath(here: string = dirname(fileURLToPath(import.meta.url))): string {
  if (process.env.CLICK_CLI) return process.env.CLICK_CLI;
  for (const p of [join(here, 'click.js'), join(here, '..', 'click.js')]) if (existsSync(p)) return p;
  return join(here, 'click.js');
}

export class ClickClient {
  readonly dir: string;
  private readonly fetchFn: typeof fetch | undefined;
  private readonly spawnFn: ClientOptions['spawnFn'];

  constructor(private readonly o: ClientOptions) {
    this.dir = o.dir ?? clickDir(o.root);
    this.fetchFn = o.fetchFn;
    this.spawnFn = o.spawnFn;
  }

  /** daemon.json, if it describes a process that is still alive (the token must never go to anything else). */
  async discover(): Promise<DaemonInfo | null> {
    const info = await readInfo(this.dir);
    return info && isPidAlive(info.pid) ? info : null;
  }

  private url(info: DaemonInfo, path: string): string {
    return `http://127.0.0.1:${info.port}${path}`;
  }

  private async fetchJson(info: DaemonInfo, path: string, init: { method: string; body?: unknown }, timeoutMs: number): Promise<{ status: number; body: unknown }> {
    const payload = init.body !== undefined ? JSON.stringify(init.body) : undefined;
    const signal = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))); // must be an integer or AbortSignal.timeout throws
    const headers = { [TOKEN_HEADER]: info.token, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) };
    const res = this.fetchFn
      ? await this.fetchFn(this.url(info, path), { method: init.method, headers, ...(payload !== undefined ? { body: payload } : {}), signal }).then(async (r) => ({ status: r.status, text: await r.text() }))
      : await nodeRequest(info.port, path, init.method, headers, payload, signal);
    const text = res.text;
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: leave body null
    }
    return { status: res.status, body };
  }

  /** GET /health; null when it does not answer in time or answers badly. */
  async health(info: DaemonInfo, timeoutMs: number = this.o.healthTimeoutMs ?? HEALTH_TIMEOUT_MS): Promise<HealthBody | null> {
    try {
      const r = await this.fetchJson(info, '/health', { method: 'GET' }, timeoutMs);
      return r.status === 200 && r.body && typeof r.body === 'object' && (r.body as HealthBody).ok ? (r.body as HealthBody) : null;
    } catch (e) {
      debug('health', e);
      return null;
    }
  }

  /**
   * Start a daemon in the background. Returns true when this call spawned one, false when another client already did (the lock
   * is fresh) or spawning failed. Never throws.
   */
  async autostart(): Promise<boolean> {
    try {
      await mkdir(this.dir, { recursive: true });
      const lock = join(this.dir, AUTOSTART_LOCK);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const fh = await open(lock, 'wx');
          await fh.writeFile(String(process.pid));
          await fh.close();
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
          const age = Date.now() - (await stat(lock).then((s) => s.mtimeMs, () => 0));
          if (age < AUTOSTART_LOCK_TTL_MS) return false; // someone started one a moment ago: it is on its way up
          await rm(lock, { force: true });
          if (attempt === 1) return false;
        }
      }
      const spawnFn = this.spawnFn ?? (await import('node:child_process')).spawn; // loaded only when a daemon really has to be started
      spawnFn(process.execPath, [this.o.cliPath ?? defaultCliPath(), 'serve', '--root', this.o.root], { detached: true, stdio: 'ignore', windowsHide: true, cwd: this.o.root }).unref();
      return true;
    } catch {
      return false;
    }
  }

  /** Hook mode: the answer, or null for any reason at all (no daemon yet, slow, error, bad data). Never throws. */
  async tryRequest<T>(path: string, o: RequestOptions): Promise<T | null> {
    try {
      const end = Date.now() + o.deadlineMs;
      const info = await this.discover();
      if (!info) {
        await this.autostart();
        return null;
      }
      if (!(await this.health(info, Math.min(this.o.healthTimeoutMs ?? HEALTH_TIMEOUT_MS, end - Date.now())))) return null;
      const left = end - Date.now();
      if (left <= 0) return null;
      const r = await this.fetchJson(info, path, { method: o.method ?? (o.body === undefined ? 'GET' : 'POST'), body: o.body }, left);
      if (r.status !== 200) debug(`${path} answered`, r.status);
      return r.status === 200 ? (r.body as T) : null;
    } catch (e) {
      debug(path, e);
      return null;
    }
  }

  /** CLI mode: like tryRequest, but the daemon must be there and failures are explained. */
  async request<T>(path: string, o: RequestOptions): Promise<T> {
    const info = await this.discover();
    if (!info) throw new ClientError('the click daemon is not running (start it with `click serve`)', 'no_daemon');
    let r: { status: number; body: unknown };
    try {
      r = await this.fetchJson(info, path, { method: o.method ?? (o.body === undefined ? 'GET' : 'POST'), body: o.body }, o.deadlineMs);
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new ClientError(timedOut ? `the daemon did not answer ${path} in ${o.deadlineMs} ms` : `could not reach the daemon: ${e instanceof Error ? e.message : String(e)}`, timedOut ? 'timeout' : 'unreachable');
    }
    if (r.status !== 200) {
      const err = (r.body as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ClientError(err?.message ?? `the daemon answered ${r.status}`, err?.code ?? 'http_error', r.status);
    }
    return r.body as T;
  }

  /** CLI mode: make sure a daemon is up (starting one if needed) and wait for it; `ready` also waits for the graph to load. */
  async ensureRunning(o: { waitMs: number; ready?: boolean }): Promise<DaemonInfo> {
    const end = Date.now() + o.waitMs;
    let started = false;
    for (;;) {
      const info = await this.discover();
      if (info) {
        const h = await this.health(info, 500);
        if (h && (!o.ready || h.status === 'ready')) return info;
      } else if (!started) {
        started = true;
        await this.autostart();
      }
      if (Date.now() >= end) throw new ClientError(`the click daemon did not become ${o.ready ? 'ready' : 'available'} within ${Math.round(o.waitMs / 1000)} s (see ${join(this.dir, 'logs')})`, 'start_timeout');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
