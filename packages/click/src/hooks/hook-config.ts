// PROMPTS 116: the few things the prompt hook needs from the repo, read without zod or any other dependency so the hook
// bundle stays tiny and starts fast. The daemon validates the same file strictly (repo-config.ts); here anything odd means "defaults".

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

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

/**
 * The repo this prompt belongs to. Click only acts in a repo that opted in (has a `.click` directory or a click.config.json), so
 * a stray `claude` in some other folder never starts a daemon there. Prefers where a daemon is already running, then Claude's
 * project directory, then the nearest ancestor of `cwd` that opted in.
 */
export function findRoot(cwd: string, env: Record<string, string | undefined> = process.env): string | null {
  const optedIn = (d: string): boolean => existsSync(join(d, '.click')) || existsSync(join(d, 'click.config.json'));
  const candidates: string[] = [];
  for (let d = cwd, i = 0; i < 10; i++) {
    candidates.push(d);
    const up = dirname(d);
    if (up === d || d === parse(d).root) break;
    d = up;
  }
  const running = candidates.find((d) => existsSync(join(d, '.click', 'daemon.json')));
  if (running) return running;
  const project = env.CLAUDE_PROJECT_DIR;
  if (project && optedIn(project)) return project;
  return candidates.find(optedIn) ?? null;
}
