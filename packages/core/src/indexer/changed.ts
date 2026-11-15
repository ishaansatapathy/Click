// PROMPTS 059: which files changed since the graph was last built?
//   committed:   git diff --name-status -M <lastIndexedCommit> HEAD
//   uncommitted: git status --porcelain (modified, added, deleted, renamed, untracked)
// Renames become delete + add. Paths come back relative to `root` (which may be a subdirectory of the repo), posix,
// unquoted (-z), and the final status is decided by the file system, not by git's letters: what the index needs to know
// is "does it exist now", and the working tree is the truth.
// Never throws: anything git cannot answer (not a repo, unknown commit) is reported as { ok: false } so the caller
// can fall back to a full re-index.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ChangedPath } from './incremental.js';

const exec = promisify(execFile);

export type ChangedResult = { ok: true; changes: ChangedPath[] } | { ok: false; reason: 'not-a-git-repo' | 'unknown-commit' | 'git-failed'; detail?: string };

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: root, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** `git diff --name-status -z` output → [status, path, oldPath?] tuples. */
export function parseNameStatusZ(out: string): { status: string; path: string; oldPath?: string }[] {
  const t = out.split('\0');
  const res: { status: string; path: string; oldPath?: string }[] = [];
  for (let i = 0; i < t.length; ) {
    const status = t[i++];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = t[i++]!;
      const path = t[i++]!;
      res.push({ status, path, oldPath });
    } else {
      res.push({ status, path: t[i++]! });
    }
  }
  return res;
}

/** `git status --porcelain=v1 -z` output → entries; renames carry the old path (porcelain -z lists `new\0old`). */
export function parsePorcelainZ(out: string): { xy: string; path: string; oldPath?: string }[] {
  const t = out.split('\0');
  const res: { xy: string; path: string; oldPath?: string }[] = [];
  for (let i = 0; i < t.length; ) {
    const entry = t[i++];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (xy.includes('R') || xy.includes('C')) res.push({ xy, path, oldPath: t[i++]! });
    else res.push({ xy, path });
  }
  return res;
}

export async function changedPaths(root: string, sinceCommit?: string | null): Promise<ChangedResult> {
  let prefix: string;
  try {
    prefix = (await git(root, ['rev-parse', '--show-prefix'])).trim(); // '' at the repo root, 'pkg/app/' inside a subdirectory
  } catch (e) {
    return { ok: false, reason: 'not-a-git-repo', detail: String(e) };
  }

  const touched = new Set<string>();
  const inRoot = (p: string): string | null => (p.startsWith(prefix) ? p.slice(prefix.length) : null);

  try {
    if (sinceCommit) {
      try {
        await git(root, ['cat-file', '-e', `${sinceCommit}^{commit}`]);
      } catch (e) {
        return { ok: false, reason: 'unknown-commit', detail: String(e) };
      }
      const diff = await git(root, ['diff', '--name-status', '-M', '-z', '--relative', sinceCommit, 'HEAD']); // --relative: already relative to root
      for (const e of parseNameStatusZ(diff)) {
        touched.add(e.path);
        if (e.oldPath) touched.add(e.oldPath);
      }
    }
    const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    for (const e of parsePorcelainZ(status)) {
      for (const p of [e.path, e.oldPath]) {
        const rel = p === undefined ? null : inRoot(p);
        if (rel) touched.add(rel);
      }
    }
  } catch (e) {
    return { ok: false, reason: 'git-failed', detail: String(e) };
  }

  const changes = [...touched]
    .sort()
    .map((path): ChangedPath => ({ path, status: existsSync(join(root, path)) ? 'M' : 'D' }));
  return { ok: true, changes };
}
