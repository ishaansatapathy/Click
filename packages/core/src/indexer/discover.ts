// SPEC §5.1: list the repo's source files, classify them, read and hash them.
// Git mode (`git ls-files -co --exclude-standard -z`) is the default; a .gitignore-aware walker is the fallback.
// Content is normalised (BOM stripped, CRLF → LF) before hashing, so the same code hashes the same on
// Windows and Linux: stable ids and content-addressed caches depend on it.

import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { FileClass, SourceFile } from '../contracts.js';
import { sha1 } from '../util/hash.js';
import { normPath } from '../util/ids.js';

export const SOURCE_EXTS = new Set(['.vue', '.ts', '.tsx', '.js', '.mjs']);
const AUTO_IMPORT_DTS = /(^|\/)(components|auto-imports)\.d\.ts$/;
const ALWAYS_SKIP_DIRS = new Set(['.git', 'node_modules']);
const DEFAULT_MAX_BYTES = 1_000_000; // minified bundles and vendored blobs are not source we want to index
const READ_CONCURRENCY = 32;

export type SkipReason = 'too-large' | 'missing' | 'unreadable';

export interface DiscoverResult {
  files: SourceFile[];
  skipped: { path: string; reason: SkipReason }[];
  mode: 'git' | 'walk';
}

export interface DiscoverOptions {
  maxBytes?: number;
  /** Force the fallback walker even inside a git repo (tests, non-git exports). */
  forceWalk?: boolean;
}

/** Index candidates: source extensions, no .d.ts except auto-import maps (read for their maps, never indexed as nodes). */
export function isCandidate(path: string): boolean {
  if (AUTO_IMPORT_DTS.test(path)) return true;
  if (path.endsWith('.d.ts')) return false;
  return SOURCE_EXTS.has(posix.extname(path));
}

export function classifyFile(path: string): FileClass {
  if (AUTO_IMPORT_DTS.test(path) || /(^|\/)dist\//.test(path) || /\.gen\.[cm]?[jt]sx?$/.test(path)) return 'generated';
  if (/(^|\/)(tests?|__tests__)\//.test(path) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(path)) return 'test';
  if (/(^|\/)[^/]+\.config\.[cm]?[jt]s$/.test(path)) return 'config';
  return 'src';
}

export function normaliseContent(raw: string): string {
  return (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n?/g, '\n');
}

export async function discover(root: string, opts: DiscoverOptions = {}): Promise<DiscoverResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const listed = opts.forceWalk ? null : await gitList(root);
  const mode = listed ? 'git' : 'walk';
  const paths = [...new Set((listed ?? (await walk(root))).map((p) => normPath(root, p)))]
    .filter(isCandidate)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const files: SourceFile[] = [];
  const skipped: DiscoverResult['skipped'] = [];
  const results = await mapLimit(paths, READ_CONCURRENCY, (p) => readOne(root, p, maxBytes));
  for (const r of results) {
    if ('reason' in r) skipped.push(r);
    else files.push(r);
  }
  return { files, skipped, mode };
}

async function readOne(root: string, path: string, maxBytes: number): Promise<SourceFile | { path: string; reason: SkipReason }> {
  const full = join(root, path);
  try {
    const st = await stat(full);
    if (st.size > maxBytes) return { path, reason: 'too-large' };
    const content = normaliseContent(await readFile(full, 'utf8'));
    return { path, content, hash: sha1(content), class: classifyFile(path) };
  } catch (e) {
    // Tracked in the index but deleted in the working tree shows up as ENOENT.
    return { path, reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

/** Tracked + untracked-but-not-ignored files, relative to `root`. Null when `root` is not inside a git work tree. */
function gitList(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let child;
    try {
      child = spawn('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.once('error', () => resolve(null));
    child.once('close', (code) => {
      if (code !== 0) return resolve(null);
      // -z: NUL-separated and unquoted, so non-ASCII and odd file names survive intact.
      resolve(Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean));
    });
  });
}

/** Fallback walker: honours .gitignore files at every level, never follows symlinks or junctions. */
async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(relDir: string, rules: { base: string; ig: Ignore }[]): Promise<void> {
    const absDir = relDir ? join(root, relDir) : root;
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    const here = entries.find((e) => e.isFile() && e.name === '.gitignore');
    const scoped = here ? [...rules, { base: relDir, ig: ignore().add(await readFile(join(absDir, '.gitignore'), 'utf8')) }] : rules;
    const ignored = (rel: string, isDir: boolean) =>
      scoped.some(({ base, ig }) => {
        const local = base ? posix.relative(base, rel) : rel;
        return local !== '' && !local.startsWith('..') && ig.ignores(isDir ? `${local}/` : local);
      });
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // junctions (e.g. bench/repo in a worktree) and symlinks: never follow
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(e.name) || ignored(rel, true)) continue;
        await visit(rel, scoped);
      } else if (e.isFile() && !ignored(rel, false)) {
        out.push(rel);
      }
    }
  }
  await visit('', []);
  return out;
}

async function mapLimit<T, U>(items: T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const out = new Array<U>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
