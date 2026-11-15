// PROMPTS 151: what did the agent change? Questions asked of git, always relative to the repo root Click serves (which may be a
// subdirectory of the git repository). Every function degrades to "I don't know" (null / empty) instead of throwing: a repo that is
// not under git, an unknown commit or a missing git binary just means the outcome carries less information.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GraphNode } from '../../../core/src/types.js';

const exec = promisify(execFile);

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec('git', args, { cwd: root, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 8_000 });
    return stdout;
  } catch {
    return null;
  }
}

export interface GitOps {
  /** HEAD, or null (no repo, no commits). */
  head(root: string): Promise<string | null>;
  /** Files that differ from `commit` in the working tree (staged, unstaged and untracked), root-relative posix paths. null: git could not tell. */
  changedFiles(root: string, commit: string | null): Promise<string[] | null>;
  /** The unified diff (zero context) of the working tree against `commit`, or null. */
  diff(root: string, commit: string): Promise<string | null>;
}

export const realGit: GitOps = {
  async head(root) {
    return (await git(root, ['rev-parse', 'HEAD']))?.trim() || null;
  },
  async changedFiles(root, commit) {
    const tracked = await git(root, ['diff', '--relative', '--name-only', '-z', commit ?? 'HEAD']);
    if (tracked === null) return null;
    const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
    return [...new Set([...tracked.split('\0'), ...(untracked ?? '').split('\0')].filter(Boolean))].sort();
  },
  async diff(root, commit) {
    return git(root, ['diff', '--relative', '-U0', '--no-color', '--no-ext-diff', commit]);
  },
};

/** `git diff -U0` output → the text of the added and removed lines, per file (root-relative path). */
export function changedLinesByFile(diff: string): Map<string, string> {
  const out = new Map<string, string[]>();
  let file: string | null = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') file = p.replace(/^b\//, ''); // a deleted file keeps the name its `---` line gave
      continue;
    }
    if (line.startsWith('--- ')) {
      if (file === null) {
        const p = line.slice(4);
        if (p !== '/dev/null') file = p.replace(/^a\//, ''); // a deleted file is named on the --- line
      }
      continue;
    }
    if (line.startsWith('diff --git')) {
      file = null;
      continue;
    }
    if ((line.startsWith('+') || line.startsWith('-')) && file) {
      const arr = out.get(file) ?? [];
      arr.push(line.slice(1));
      out.set(file, arr);
    }
  }
  return new Map([...out].map(([f, l]) => [f, l.join('\n')]));
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Names of the given nodes that appear (as whole words) in added or removed lines of THEIR OWN file. Names shorter than 3 characters
 * are ignored (a one-letter parameter would match everywhere).
 */
export function symbolsInDiff(diff: string, nodes: readonly Pick<GraphNode, 'path' | 'name'>[]): string[] {
  const byFile = changedLinesByFile(diff);
  const hit = new Set<string>();
  for (const n of nodes) {
    if (!n.path || n.name.length < 3) continue;
    const text = byFile.get(n.path);
    if (text && new RegExp(`(?<![\\w$])${escapeRe(n.name)}(?![\\w$])`).test(text)) hit.add(n.name);
  }
  return [...hit].sort();
}
