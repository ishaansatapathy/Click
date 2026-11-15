// PROMPTS 177: `click statusline`, for Claude Code's `statusLine` setting. Claude Code runs the command after each update and
// shows its first line under the prompt:  Click ▸ 3.1k ctx · 7 files · 240 ms   (or  Click ▸ idle).
// It must be fast (< 50 ms), so this module uses node:fs and node:path only and is bundled on its own as dist/hooks/statusline.js.
// The numbers come from the daemon's .click/stats.json (written at most once a second); nothing here talks to the daemon.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface StatsFile {
  last?: { tokens?: number; files?: number; ms?: number; degraded?: string[]; ts?: string };
}

/** A context older than this is not "what Click is doing now". */
export const IDLE_AFTER_MS = 30 * 60_000;

const kTokens = (n: number): string => (n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(Math.round(n)));

export function formatStatus(stats: StatsFile | null, now: number = Date.now()): string {
  const last = stats?.last;
  const at = last?.ts ? Date.parse(last.ts) : NaN;
  if (!last || typeof last.tokens !== 'number' || !Number.isFinite(at) || now - at > IDLE_AFTER_MS) return 'Click ▸ idle';
  const parts = [`${kTokens(last.tokens)} ctx`, `${last.files ?? 0} files`, `${Math.round(last.ms ?? 0)} ms`];
  if (last.degraded?.includes('graph-replica')) parts.push('replica');
  return `Click ▸ ${parts.join(' · ')}`;
}

/** The nearest directory at or above `start` that holds a .click/stats.json. */
export function findStatsFile(start: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 25; i++) {
    const f = join(dir, '.click', 'stats.json');
    if (existsSync(f)) return f;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

function readStats(file: string | null): StatsFile | null {
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as StatsFile;
  } catch {
    return null;
  }
}

/** Claude Code passes a JSON object on stdin; its workspace directory is the repo to report on. */
export function cwdFromPayload(raw: string, fallback: string): string {
  try {
    const j = JSON.parse(raw) as { workspace?: { current_dir?: unknown; project_dir?: unknown }; cwd?: unknown };
    const dir = j.workspace?.current_dir ?? j.workspace?.project_dir ?? j.cwd;
    return typeof dir === 'string' && dir ? dir : fallback;
  } catch {
    return fallback;
  }
}

export async function runStatusline(_argv: readonly string[], io: { out: (t: string) => void }, cwd: string = process.cwd(), stdin: string = ''): Promise<number> {
  io.out(formatStatus(readStats(findStatsFile(cwdFromPayload(stdin, cwd)))));
  return 0;
}

// ---------------------------------------------------------------- install (click init --statusline)

const isOurs = (command: unknown): boolean => typeof command === 'string' && /hooks[\\/]statusline\.js/.test(command);

/** Add Click's statusLine to .claude/settings.local.json, unless the user already has a statusLine of their own. */
export function installStatusline(root: string, scriptPath: string): 'installed' | 'kept-existing' | 'already' {
  const file = join(root, '.claude', 'settings.local.json');
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // no file yet
  }
  const current = settings.statusLine as { command?: unknown } | undefined;
  if (current && !isOurs(current.command)) return 'kept-existing';
  const command = `node "${scriptPath.replace(/\\/g, '/')}"`;
  if (current && current.command === command) return 'already';
  settings.statusLine = { type: 'command', command, padding: 0 };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return 'installed';
}

/** Remove Click's statusLine (and only Click's). */
export function uninstallStatusline(root: string): boolean {
  const file = join(root, '.claude', 'settings.local.json');
  try {
    const settings = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!isOurs((settings.statusLine as { command?: unknown } | undefined)?.command)) return false;
    delete settings.statusLine;
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
