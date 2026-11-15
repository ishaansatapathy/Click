// PROMPTS 157: files that change together in git history are related even when no import says so. Mine those pairs from the commits
// BEFORE a point H and turn the strong ones into `co_changed` edges (meta.source = 'git'), so the graph can bridge "edit the store, also
// touch the table component" the way the team's own history does.
//   - merge commits and sweeping commits (more than `maxFilesPerCommit` files: renames, formatting, dependency bumps) say nothing
//     about what belongs together and are skipped
//   - support >= 2 commits and Jaccard >= 0.3 (shared commits / commits touching either file) to keep a pair
//   - EVERY commit named in `exclude` contributes nothing. The benchmark excludes its task commits: their diffs are the ground truth,
//     so mining them would leak the answer into the graph. Excluding is by SHA, so it holds however the history is shaped.
// Behind the `learn.gitCoChange` flag: off unless a repo (or a benchmark row) asks for it.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { GraphEdge } from '../types.js';

const exec = promisify(execFile);

export interface CoChangeOptions {
  /** Mine commits reachable from this revision (default HEAD). The benchmark passes its pinned commit H. */
  before?: string;
  /** Commits that must not contribute, by full SHA. */
  exclude?: ReadonlySet<string>;
  /** Only files in this set take part (the indexed files). */
  files?: ReadonlySet<string>;
  minSupport?: number;
  minJaccard?: number;
  maxFilesPerCommit?: number;
  maxCommits?: number;
}

export interface CoChangeResult {
  edges: GraphEdge[];
  stats: { commits: number; used: number; excluded: number; skippedLarge: number; pairsSeen: number; kept: number };
}

const DEFAULTS = { minSupport: 2, minJaccard: 0.3, maxFilesPerCommit: 30, maxCommits: 3_000 };

/** One 40-hex SHA per line; blank lines and `#` comments are ignored. */
export async function loadExcludedShas(file: string): Promise<Set<string>> {
  const text = await readFile(file, 'utf8');
  return new Set(
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*/, '').trim().toLowerCase())
      .filter((l) => /^[0-9a-f]{40}$/.test(l)),
  );
}

interface Commit {
  sha: string;
  files: string[];
}

async function history(root: string, before: string, maxCommits: number): Promise<Commit[] | null> {
  try {
    const { stdout } = await exec(
      'git',
      ['-c', 'core.quotePath=false', 'log', before, '--no-merges', '--name-only', '--diff-filter=ACMR', '-M', '--relative', `-n${maxCommits}`, '--pretty=format:%x01%H'],
      { cwd: root, windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 60_000 },
    );
    return stdout
      .split('\x01')
      .filter(Boolean)
      .map((chunk) => {
        const [sha, ...rest] = chunk.split(/\r?\n/);
        return { sha: sha!.trim().toLowerCase(), files: rest.map((f) => f.trim()).filter(Boolean) };
      });
  } catch {
    return null; // not a git repo, unknown revision
  }
}

export async function mineCoChange(root: string, opts: CoChangeOptions = {}): Promise<CoChangeResult> {
  const o = { ...DEFAULTS, ...opts };
  const stats = { commits: 0, used: 0, excluded: 0, skippedLarge: 0, pairsSeen: 0, kept: 0 };
  const commits = await history(root, o.before ?? 'HEAD', o.maxCommits);
  if (!commits) return { edges: [], stats };
  stats.commits = commits.length;

  const perFile = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const c of commits) {
    if (o.exclude?.has(c.sha)) {
      stats.excluded++;
      continue;
    }
    const files = [...new Set(o.files ? c.files.filter((f) => o.files!.has(f)) : c.files)].sort();
    if (c.files.length > o.maxFilesPerCommit) {
      stats.skippedLarge++;
      continue;
    }
    if (files.length === 0) continue;
    stats.used++;
    for (const f of files) perFile.set(f, (perFile.get(f) ?? 0) + 1);
    for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) pairs.set(`${files[i]}\0${files[j]}`, (pairs.get(`${files[i]}\0${files[j]}`) ?? 0) + 1);
  }

  stats.pairsSeen = pairs.size;
  const edges: GraphEdge[] = [];
  for (const [pair, support] of pairs) {
    if (support < o.minSupport) continue;
    const [a, b] = pair.split('\0') as [string, string];
    const jaccard = support / (perFile.get(a)! + perFile.get(b)! - support);
    if (jaccard < o.minJaccard) continue;
    const from = `file:${a}`;
    const to = `file:${b}`;
    edges.push({ key: `${from}|co_changed|${to}`, from, to, kind: 'co_changed', meta: { source: 'git', support } });
  }
  edges.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  stats.kept = edges.length;
  return { edges, stats };
}
