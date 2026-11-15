// PROMPTS 116: the few things the prompt hook needs from the repo, read without zod or any other dependency so the hook
// bundle stays tiny and starts fast. The daemon validates the same file strictly (repo-config.ts); here anything odd means "defaults".

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';

export interface HookConfig {
  mode: 'always' | 'first' | 'off';
  budgetTokens: number;
}

export const DEFAULT_HOOK_BUDGET = 4_000;

export function readHookConfig(root: string): HookConfig {
  const out: HookConfig = { mode: 'always', budgetTokens: DEFAULT_HOOK_BUDGET };
  try {
    const h = (JSON.parse(readFileSync(join(root, 'click.config.json'), 'utf8')) as { hook?: { mode?: unknown; budgetTokens?: unknown } }).hook;
    if (h?.mode === 'always' || h?.mode === 'first' || h?.mode === 'off') out.mode = h.mode;
    if (typeof h?.budgetTokens === 'number' && Number.isInteger(h.budgetTokens) && h.budgetTokens >= 500 && h.budgetTokens <= 32_000) out.budgetTokens = h.budgetTokens;
  } catch {
    // no file, or not valid JSON: defaults
  }
  return out;
}

/** The marker `click hooks install` (and `click init`) leave in a repo: this repo opted in. */
export const OPT_IN_FILE = join('.click', 'enabled');

const same = (a: string, b: string): boolean => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/**
 * Has this directory opted in to Click? Only an explicit sign counts: a click.config.json, the marker file, a running daemon, or
 * an index that was built here. A bare `.click` directory does NOT: it is also where machine-wide state lives (for example the
 * HydraDB token in `~/.click`), and that must never turn every folder below it into a Click repo. The home directory itself and the
 * filesystem root are never repos.
 */
export function isOptedIn(dir: string, home: string = homedir()): boolean {
  if (same(dir, home) || dir === parse(dir).root) return false;
  return ['click.config.json', OPT_IN_FILE, join('.click', 'daemon.json'), join('.click', 'graph', 'CURRENT')].some((f) => existsSync(join(dir, f)));
}

/**
 * The repo this prompt belongs to. Click only acts in a repo that opted in (see isOptedIn), so a stray `claude` in some other folder
 * never starts a daemon there. Prefers where a daemon is already running, then Claude's project directory, then the nearest
 * ancestor of `cwd` that opted in.
 */
export function findRoot(cwd: string, env: Record<string, string | undefined> = process.env, home: string = homedir()): string | null {
  const candidates: string[] = [];
  for (let d = cwd, i = 0; i < 10; i++) {
    candidates.push(d);
    const up = dirname(d);
    if (up === d || d === parse(d).root) break;
    d = up;
  }
  const optedIn = (d: string): boolean => isOptedIn(d, home);
  const running = candidates.find((d) => !same(d, home) && existsSync(join(d, '.click', 'daemon.json')));
  if (running) return running;
  const project = env.CLAUDE_PROJECT_DIR;
  if (project && optedIn(project)) return project;
  return candidates.find(optedIn) ?? null;
}
