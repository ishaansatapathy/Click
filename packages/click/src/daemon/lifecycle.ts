// PROMPTS 110 / SPEC §11.1: one daemon per repo, discoverable and cleaned up.
//   .click/daemon.json  { v, pid, port, token, startedAt, version, root }, written atomically
//   .click/daemon.lock  created exclusively, holds the pid; a lock whose pid is dead is stale and is removed (once)
// The lock is what stops two clients that both find "no daemon" from both starting one.

import { open, readFile, rm, stat } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../../core/src/util/atomic.js';

export interface DaemonInfo {
  v: 1;
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  version: string;
  root: string;
}

export const daemonPaths = (dir: string): { info: string; lock: string } => ({ info: join(dir, 'daemon.json'), lock: join(dir, 'daemon.lock') });

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, but not ours to signal
  }
}

export class DaemonLockedError extends Error {
  constructor(readonly pid: number | null) {
    super(pid ? `another click daemon is running (pid ${pid})` : 'another click daemon is starting');
    this.name = 'DaemonLockedError';
  }
}

const FRESH_LOCK_MS = 2_000; // a lock file that exists but is still empty belongs to a process that is mid-write

/** Take the lock, or throw DaemonLockedError. Returns a release function (removes the lock only if it is still ours). */
export async function acquireLock(dir: string, pid: number = process.pid, alive: (pid: number) => boolean = isPidAlive): Promise<() => Promise<void>> {
  const { lock } = daemonPaths(dir);
  await mkdir(dir, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await open(lock, 'wx');
      try {
        await fh.writeFile(String(pid));
      } finally {
        await fh.close();
      }
      return async () => {
        if ((await readPid(lock)) === pid) await rm(lock, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const holder = await readPid(lock);
    if (holder !== null && alive(holder)) throw new DaemonLockedError(holder);
    if (holder === null && (await ageMs(lock)) < FRESH_LOCK_MS) throw new DaemonLockedError(null);
    if (attempt >= 1) throw new DaemonLockedError(holder); // lost the race for the stale lock too
    await rm(lock, { force: true }); // stale: its owner is dead
  }
}

async function readPid(file: string): Promise<number | null> {
  try {
    const n = Number.parseInt((await readFile(file, 'utf8')).trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function ageMs(file: string): Promise<number> {
  try {
    return Date.now() - (await stat(file)).mtimeMs;
  } catch {
    return Infinity;
  }
}

export async function writeInfo(dir: string, info: DaemonInfo): Promise<void> {
  await writeFileAtomic(daemonPaths(dir).info, JSON.stringify(info));
}

export async function readInfo(dir: string): Promise<DaemonInfo | null> {
  try {
    const o = JSON.parse(await readFile(daemonPaths(dir).info, 'utf8')) as Partial<DaemonInfo>;
    if (o.v !== 1 || !Number.isInteger(o.pid) || !Number.isInteger(o.port) || typeof o.token !== 'string' || typeof o.root !== 'string') return null;
    return o as DaemonInfo;
  } catch {
    return null;
  }
}

/** Remove daemon.json, but only when it describes `pid` (a newer daemon's file is not ours to delete). */
export async function removeInfo(dir: string, pid: number = process.pid): Promise<void> {
  const info = await readInfo(dir);
  if (!info || info.pid === pid) await rm(daemonPaths(dir).info, { force: true });
}

/**
 * Run `onShutdown` once on SIGINT / SIGTERM / SIGBREAK (Ctrl+Break and console close on Windows). A second signal while shutting
 * down exits immediately. Returns a function that removes the handlers.
 */
export function installShutdown(onShutdown: (reason: string) => Promise<void>, proc: Pick<NodeJS.Process, 'on' | 'off' | 'exit'> = process): () => void {
  let running = false;
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGBREAK' as NodeJS.Signals];
  const handler = (signal: NodeJS.Signals): void => {
    if (running) return void proc.exit(1);
    running = true;
    onShutdown(signal).then(
      () => proc.exit(0),
      () => proc.exit(1),
    );
  };
  for (const s of signals) proc.on(s, handler);
  return () => {
    for (const s of signals) proc.off(s, handler);
  };
}
