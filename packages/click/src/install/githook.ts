// PROMPTS 118: a git `post-commit` hook that tells the daemon to refresh its graph after every commit.
//   - a plain `sh` script, which also runs under Git for Windows (Git ships its own sh), so one hook works everywhere
//   - runs `node "<abs>/click.js" reindex --changed` in the BACKGROUND with all output discarded and `exit 0`: it can never slow
//     down or fail a commit. With no daemon running `reindex --changed` does nothing.
//   - chained after an existing hook: the user's own post-commit is moved to `post-commit.pre-click` and called first, unchanged.
//     Uninstalling puts it back.
//   - respects `core.hooksPath` and worktrees (the hooks directory is asked of git itself).
// The script is delimited by markers so a re-install updates it in place and uninstall knows what is ours.

import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic } from '../../../core/src/util/atomic.js';

const exec = promisify(execFile);

export class GitHookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHookError';
  }
}

export interface GitHookOptions {
  root: string;
  /** Absolute path of the click CLI (`dist/click.js`). */
  cliPath: string;
  /** Node to fall back on when `node` is not on the PATH git sees. Default: the node running this. */
  nodePath?: string;
  /** Hook names to install. Default: post-commit only (SPEC). */
  events?: readonly string[];
}

export interface GitHookResult {
  hooksDir: string;
  /** Hook files written (or confirmed up to date). */
  hooks: string[];
  /** Existing hooks that were kept and are called first. */
  chained: string[];
  changed: boolean;
}

export const START = '# >>> click (managed block: `click uninstall` removes it) >>>';
export const END = '# <<< click <<<';
const ORIG_SUFFIX = '.pre-click';

/** POSIX single-quote escaping: safe for spaces, quotes, `$` and backticks in a path. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const fwd = (p: string): string => p.replace(/\\/g, '/');

export function hookScript(event: string, o: { cliPath: string; nodePath: string }): string {
  return [
    '#!/bin/sh',
    START,
    `# Keeps Click's code graph current after git changes. Runs in the background; never slows down or fails git.`,
    'click_hook_dir=$(dirname "$0")',
    `if [ -x "$click_hook_dir/${event}${ORIG_SUFFIX}" ]; then`,
    `  "$click_hook_dir/${event}${ORIG_SUFFIX}" "$@" || true`,
    'fi',
    'click_node=$(command -v node 2>/dev/null)',
    `[ -n "$click_node" ] || click_node=${shq(fwd(o.nodePath))}`,
    `( "$click_node" ${shq(fwd(o.cliPath))} reindex --changed >/dev/null 2>&1 & ) >/dev/null 2>&1`,
    END,
    'exit 0',
    '',
  ].join('\n');
}

async function hooksDirOf(root: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, windowsHide: true });
    return resolve(root, stdout.trim());
  } catch {
    throw new GitHookError(`${root} is not inside a git repository`);
  }
}

const isOurs = (text: string): boolean => text.includes(START);
const readIf = (p: string): Promise<string | null> => readFile(p, 'utf8').then((t) => t, () => null);

export async function installGitHook(o: GitHookOptions): Promise<GitHookResult> {
  const hooksDir = await hooksDirOf(o.root);
  await mkdir(hooksDir, { recursive: true });
  const events = o.events ?? ['post-commit'];
  const result: GitHookResult = { hooksDir, hooks: [], chained: [], changed: false };
  for (const event of events) {
    const file = join(hooksDir, event);
    const keep = file + ORIG_SUFFIX;
    const existing = await readIf(file);
    if (existing !== null && !isOurs(existing)) {
      if (existsSync(keep)) throw new GitHookError(`${file} is someone else's hook and ${keep} already exists; merge them by hand first`);
      await rename(file, keep); // keeps its permissions
      result.chained.push(keep);
      result.changed = true;
    } else if (existsSync(keep)) {
      result.chained.push(keep);
    }
    const script = hookScript(event, { cliPath: resolve(o.cliPath), nodePath: o.nodePath ?? process.execPath });
    if (existing !== script) {
      await writeFileAtomic(file, script);
      result.changed = true;
    }
    await chmod(file, 0o755).catch(() => undefined); // no-op on Windows, where Git runs hooks through sh regardless
    result.hooks.push(file);
  }
  return result;
}

export async function uninstallGitHook(o: { root: string; events?: readonly string[] }): Promise<{ removed: string[]; restored: string[] }> {
  const hooksDir = await hooksDirOf(o.root);
  const removed: string[] = [];
  const restored: string[] = [];
  for (const event of o.events ?? ['post-commit']) {
    const file = join(hooksDir, event);
    const keep = file + ORIG_SUFFIX;
    const text = await readIf(file);
    if (text !== null && isOurs(text)) {
      await rm(file, { force: true });
      removed.push(file);
    } else if (text !== null) {
      continue; // not ours: leave it alone
    }
    if (existsSync(keep) && !existsSync(file)) {
      await rename(keep, file);
      restored.push(file);
    }
  }
  return { removed, restored };
}
