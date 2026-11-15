// PROMPTS 057 / SPEC §5.7: root directory → graph (+ chunks, conventions, stats), in one call.
//   discover → build the extract context → extract every file (content-addressed disk cache) → link → version.
// Single-threaded on purpose: extracting 100 Vue files takes ~0.15 s, so a worker pool would spend more time
// loading TypeScript per worker than it saves (see DECISIONS). The loop yields to the event loop so a daemon
// stays responsive while it re-indexes a large repo.

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BuildGraph, FileExtract, SourceFile } from '../contracts.js';
import type { ChunkRecord, Convention, Graph } from '../types.js';
import { DiskCache } from '../util/diskCache.js';
import { hashOf, sha1, stableStringify } from '../util/hash.js';
import { clickDir } from '../util/paths.js';
import { extractConventions } from './conventions.js';
import { discover } from './discover.js';
import { EXTRACTOR_VERSION, buildExtractCtx, ctxHashOf, extractFile } from './extract.js';
import { link, type LinkStats } from './link.js';
import { profileRepo, type RepoProfile } from './profile.js';

const exec = promisify(execFile);
const YIELD_EVERY = 40;
const CACHE_WRITE_BATCH = 32;

export interface BuildOptions {
  /** Where extract results are cached. Default: `<clickDir(root)>/cache` (`.click/cache` unless CLICK_HOME is set). */
  cacheDir?: string;
  /** Set false to bypass the cache entirely. */
  cache?: boolean;
  now?: () => Date;
  maxBytes?: number;
}

export interface BuildStats {
  files: number;
  byClass: Record<string, number>;
  skipped: { path: string; reason: string }[];
  extractCacheHits: number;
  extractCacheMisses: number;
  nodesByKind: Record<string, number>;
  edgesByKind: Record<string, number>;
  imports: { local: number; external: number; unresolved: number };
  /** Share of repo-local imports that did not resolve (G1 gate: < 2%). */
  unresolvedLocalRatio: number;
  unresolvedSpecs: { spec: string; count: number }[];
  link: LinkStats;
  ms: { discover: number; extract: number; link: number; total: number };
}

export interface BuildResult {
  graph: Graph;
  /** Chunk records WITH text, for semantic indexing. `graph.chunks` carries them without text. */
  chunks: ChunkRecord[];
  conventions: Convention[];
  stats: BuildStats;
}

const count = <T>(items: Iterable<T>, key: (x: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of items) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
};

async function repoCommit(root: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true });
    return /^[0-9a-f]{40}$/.test(stdout.trim()) ? stdout.trim() : null;
  } catch {
    return null;
  }
}

/** SPEC §7: version = hash of sorted node ids, sorted edge keys and sorted (path, fileHash). */
export function graphVersion(nodeIds: readonly string[], edgeKeys: readonly string[], files: readonly { path: string; hash: string }[]): string {
  return hashOf({ nodes: nodeIds, edges: edgeKeys, files: files.map((f) => [f.path, f.hash]).sort() });
}

export async function buildIndex(root: string, profile?: RepoProfile, opts: BuildOptions = {}): Promise<BuildResult> {
  const t0 = performance.now();
  const prof = profile ?? profileRepo(root);
  const d = await discover(root, opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {});
  const t1 = performance.now();

  const ctx = buildExtractCtx(root, prof, d.files, d.allPaths);
  const ctxHash = ctxHashOf(ctx);
  const cache = opts.cache === false ? null : new DiskCache('extract', { dir: opts.cacheDir ?? join(clickDir(root), 'cache'), cacheOnly: false });

  const extracts = new Map<string, FileExtract>();
  let hits = 0;
  let misses = 0;
  const pending: Promise<void>[] = [];
  for (let i = 0; i < d.files.length; i++) {
    const f: SourceFile = d.files[i]!;
    const key = sha1(stableStringify({ h: f.hash, v: EXTRACTOR_VERSION, c: ctxHash }));
    const cached = cache ? await cache.peek<FileExtract>(key) : undefined;
    if (cached) {
      hits++;
      extracts.set(f.path, cached);
    } else {
      misses++;
      const x = extractFile(f, ctx);
      extracts.set(f.path, x);
      if (cache) {
        pending.push(cache.set(key, x).catch(() => {})); // a failed cache write must never fail the build
        if (pending.length >= CACHE_WRITE_BATCH) await Promise.all(pending.splice(0));
      }
    }
    if (i % YIELD_EVERY === YIELD_EVERY - 1) await new Promise<void>((r) => setImmediate(r));
  }
  await Promise.all(pending);
  const t2 = performance.now();

  const linked = link({ extracts, fileHashes: new Map(d.files.map((f) => [f.path, f.hash])) });
  const t3 = performance.now();

  const version = graphVersion(linked.nodes.map((n) => n.id), linked.edges.map((e) => e.key), d.files);
  const graph: Graph = {
    version,
    repoCommit: await repoCommit(root),
    nodes: linked.nodes,
    edges: linked.edges,
    chunks: linked.chunks.map(({ id, nodeId, path, range }) => ({ id, nodeId, path, range })),
  };
  const conventions = await extractConventions({ root, files: d.files, profile: prof, now: opts.now?.() ?? new Date() });

  const imports = { local: 0, external: 0, unresolved: 0 };
  const unresolved = new Map<string, number>();
  for (const x of extracts.values()) {
    for (const imp of x.imports) {
      imports[imp.resolved.kind === 'local' ? 'local' : imp.resolved.kind === 'external' ? 'external' : 'unresolved']++;
      if (imp.resolved.kind === 'unresolved') unresolved.set(imp.spec, (unresolved.get(imp.spec) ?? 0) + 1);
    }
  }
  const stats: BuildStats = {
    files: d.files.length,
    byClass: count(d.files, (f) => f.class),
    skipped: d.skipped,
    extractCacheHits: hits,
    extractCacheMisses: misses,
    nodesByKind: count(graph.nodes, (n) => n.kind),
    edgesByKind: count(graph.edges, (e) => e.kind),
    imports,
    unresolvedLocalRatio: imports.local + imports.unresolved === 0 ? 0 : imports.unresolved / (imports.local + imports.unresolved),
    unresolvedSpecs: [...unresolved].map(([spec, n]) => ({ spec, count: n })).sort((a, b) => b.count - a.count || (a.spec < b.spec ? -1 : 1)).slice(0, 20),
    link: linked.stats,
    ms: { discover: Math.round(t1 - t0), extract: Math.round(t2 - t1), link: Math.round(t3 - t2), total: Math.round(performance.now() - t0) },
  };
  return { graph, chunks: linked.chunks, conventions, stats };
}

/** The frozen contract entry point (contracts.BuildGraph). */
export const buildGraph: BuildGraph = async (root, profile) => (await buildIndex(root, profile)).graph;
