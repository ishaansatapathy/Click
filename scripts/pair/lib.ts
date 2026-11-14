// Pair-mode helpers (PLAN §14): path ownership, commit checks, locating MAIN, and shell-free process spawning.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import picomatch from 'picomatch';

export type Seat = 'a' | 'b';
export type OwnerClass = 'frozen' | 'shared' | 'open' | 'laneA' | 'laneB' | 'unowned';

export interface OwnershipRules {
  frozen: string[];
  shared: string[];
  open: string[];
  laneA: string[];
  laneB: string[];
}

const ORDER = ['frozen', 'shared', 'open', 'laneA', 'laneB'] as const;
const here = dirname(fileURLToPath(import.meta.url));

export const laneOf = (seat: Seat): 'laneA' | 'laneB' => (seat === 'a' ? 'laneA' : 'laneB');
export const toPosixPath = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');

export function loadOwnership(file = join(here, 'ownership.json')): OwnershipRules {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<OwnershipRules>;
  return {
    frozen: raw.frozen ?? [],
    shared: raw.shared ?? [],
    open: raw.open ?? [],
    laneA: raw.laneA ?? [],
    laneB: raw.laneB ?? [],
  };
}

export type Classifier = (path: string) => OwnerClass;

/** Compile the globs once. Classes are tried in a fixed order (frozen first); the first match wins. */
export function makeClassifier(rules: OwnershipRules = loadOwnership()): Classifier {
  const matchers = ORDER.map((cls) => [cls, picomatch(rules[cls], { dot: true })] as const);
  return (path) => {
    const p = toPosixPath(path);
    for (const [cls, isMatch] of matchers) if (isMatch(p)) return cls;
    return 'unowned';
  };
}

// ---------------------------------------------------------------- commit checks

export interface FileChange {
  status: string; // git name-status letter(s): A, M, D, R100, C75…
  path: string;
  oldPath?: string; // set for renames and copies
}

export interface Violation {
  sha?: string;
  subject?: string;
  path: string;
  cls: OwnerClass;
  reason: string;
}

const CONTRACT_SUBJECT = /^contract[:/(]/i;

/**
 * Ownership rules for one commit (PLAN §14.4):
 *  - the other lane's files are off limits;
 *  - frozen files change only in a commit whose subject starts with "contract:" (PLAN §14.8);
 *  - shared and unowned files must be in a commit of their own, never mixed with lane files.
 * Renames count both the old and the new path, so moving a file out of another lane is caught.
 */
export function checkCommitFiles(seat: Seat, changes: FileChange[], subject: string, classify: Classifier): Violation[] {
  const own = laneOf(seat);
  const other = seat === 'a' ? 'laneB' : 'laneA';
  const paths = [...new Set(changes.flatMap((c) => (c.oldPath ? [c.oldPath, c.path] : [c.path])).map(toPosixPath))];
  const classes = paths.map((path) => ({ path, cls: classify(path) }));
  const isContract = CONTRACT_SUBJECT.test(subject);
  const touchesLane = classes.some((c) => c.cls === own || c.cls === other);
  const out: Violation[] = [];

  for (const { path, cls } of classes) {
    if (cls === other) {
      out.push({ path, cls, reason: `owned by ${other}: file a T9 request to the other seat instead` });
    } else if (cls === 'frozen' && !isContract) {
      out.push({ path, cls, reason: 'frozen contract: needs an approved contract change and a "contract:" commit (PLAN §14.8)' });
    } else if ((cls === 'shared' || cls === 'unowned') && touchesLane && !isContract) {
      out.push({ path, cls, reason: `${cls} file mixed with lane files: put it in a commit of its own` });
    }
  }
  return out;
}

export function parseNameStatus(text: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [status = '', a = '', b] = line.split('\t');
    if ((status.startsWith('R') || status.startsWith('C')) && b !== undefined) changes.push({ status, oldPath: a, path: b });
    else changes.push({ status, path: a });
  }
  return changes;
}

/** Check every commit in `range` (e.g. "main..HEAD"). Empty result means the range is clean. */
export async function checkCommits(range: string, seat: Seat, cwd: string, classify: Classifier = makeClassifier()): Promise<Violation[]> {
  const shas = (await git(['rev-list', '--reverse', range], cwd)).split(/\r?\n/).filter(Boolean);
  const out: Violation[] = [];
  for (const sha of shas) {
    const subject = (await git(['log', '-1', '--format=%s', sha], cwd)).trim();
    const changes = parseNameStatus(await git(['diff-tree', '--root', '--no-commit-id', '-r', '-M', '--name-status', sha], cwd));
    for (const v of checkCommitFiles(seat, changes, subject, classify)) out.push({ ...v, sha, subject });
  }
  return out;
}

// ---------------------------------------------------------------- locating MAIN

export interface PairInfo {
  seat: Seat | null; // null when running in MAIN
  main: string;
  worktree: string | null;
}

/** Walk up from `start` for a worktree's `.pair.json`; otherwise accept MAIN itself (has `coord/pair.json`). */
export function readPair(start: string = process.cwd()): PairInfo | null {
  let dir = resolve(start);
  for (;;) {
    const marker = join(dir, '.pair.json');
    if (existsSync(marker)) {
      const v = JSON.parse(readFileSync(marker, 'utf8')) as { seat: Seat; main: string; worktree: string };
      return { seat: v.seat, main: v.main, worktree: v.worktree };
    }
    if (existsSync(join(dir, 'coord', 'pair.json'))) return { seat: null, main: dir, worktree: null };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---------------------------------------------------------------- processes

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Only for commands that need it (e.g. .cmd shims on Windows). Never pass untrusted input with shell: true. */
  shell?: boolean;
}

/** Spawn without a shell. Never throws on a non-zero exit; spawn failures come back as code -1. */
export function run(cmd: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: opts.shell ?? false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.once('error', (e) => resolvePromise({ code: -1, stdout, stderr: stderr + String(e) }));
    child.once('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

export async function git(args: readonly string[], cwd: string): Promise<string> {
  const r = await run('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr.trim()}`);
  return r.stdout;
}

/**
 * Run pnpm. Under `pnpm <script>`, npm_execpath points at pnpm's JS entry, so we call it with node directly:
 * no shell, and no Windows .cmd shim (which Node refuses to spawn without a shell).
 */
export function runPnpm(args: readonly string[], opts: RunOptions): Promise<RunResult> {
  const execPath = process.env.npm_execpath;
  if (execPath && /\.(c|m)?js$/.test(execPath)) return run(process.execPath, [execPath, ...args], opts);
  return run('pnpm', args, { ...opts, shell: process.platform === 'win32' });
}
