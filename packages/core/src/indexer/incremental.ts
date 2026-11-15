// PROMPTS 058 / SPEC §5.7: update the graph after a few files changed, without re-extracting the repo.
//
// Correctness argument (the property test checks it against a full rebuild after random edits):
//   a file's extract depends only on (its content, the resolution of its own imports, the global component
//   registrations, the profile). So a file must be re-extracted exactly when
//     1. its content changed, or
//     2. one of its imports now resolves differently (target added / deleted / shadowed by a new file), or
//     3. the global registrations changed and it is a .vue file, or
//     4. the profile changed (tsconfig / vite config / auto-import maps): then we fall back to a full rebuild.
//   Everything else is reused. Linking is a cheap whole-graph pass (~20 ms for 100 files), so it always runs over
//   all extracts; the delta is the diff between the old and the new graph. That keeps cross-file edges (barrels,
//   route path constants, reversed edges) correct without any special cases.

import type { FileExtract, SourceFile } from '../contracts.js';
import type { ChunkRecord, Graph, GraphDelta } from '../types.js';
import { stableStringify } from '../util/hash.js';
import { normPath } from '../util/ids.js';
import { assembleGraph, buildIndex, graphVersion, repoCommit, withExtraEdges, type BuildOptions, type IndexState } from './build.js';
import { isCandidate, readSourceFile } from './discover.js';
import { extractFile, fileRegistrations, makeExtractCtx, mergeRegistrations, type Registrations } from './extract.js';
import { makeResolver } from './resolve.js';

export interface ChangedPath {
  path: string;
  /** A and M mean "present now"; D means "gone". The index decides what that changes. */
  status: 'A' | 'M' | 'D';
}

export interface UpdateStats {
  changed: number;
  reExtracted: number;
  /** Re-extracted only because an import resolves differently or the global registrations changed. */
  dependents: number;
  fullRebuild: boolean;
  reason?: string;
  delta: { nodes: [number, number]; edges: [number, number]; chunks: [number, number] }; // [upserted, deleted]
  ms: { total: number; extract: number; link: number; diff: number };
}

export interface UpdateResult {
  state: IndexState;
  delta: GraphDelta;
  stats: UpdateStats;
}

/** Changes that invalidate the profile (aliases, auto-import maps), so every extract may differ. */
const PROFILE_INPUT = /(^|\/)(tsconfig[^/]*\.json|(vite|vitest)\.config\.[cm]?[jt]s|components\.d\.ts|auto-imports\.d\.ts|package\.json)$/;
export const needsFullRebuild = (path: string): boolean => PROFILE_INPUT.test(path);

const same = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);

// ---------------------------------------------------------------- diff / apply

/** Everything needed to turn graph A into graph B, as upserts and deletes. */
export function diffGraphs(prev: { graph: Graph; chunks: readonly ChunkRecord[] }, next: { graph: Graph; chunks: readonly ChunkRecord[] }): GraphDelta {
  const pn = new Map(prev.graph.nodes.map((n) => [n.id, n]));
  const pe = new Map(prev.graph.edges.map((e) => [e.key, e]));
  const pc = new Map(prev.chunks.map((c) => [c.id, c]));
  const nn = new Map(next.graph.nodes.map((n) => [n.id, n]));
  const ne = new Map(next.graph.edges.map((e) => [e.key, e]));
  const nc = new Map(next.chunks.map((c) => [c.id, c]));
  return {
    fromVersion: prev.graph.version,
    upsertNodes: next.graph.nodes.filter((n) => !pn.has(n.id) || !same(pn.get(n.id), n)),
    upsertEdges: next.graph.edges.filter((e) => !pe.has(e.key) || !same(pe.get(e.key), e)),
    upsertChunks: next.chunks.filter((c) => !pc.has(c.id) || !same(pc.get(c.id), c)),
    deleteNodeIds: prev.graph.nodes.filter((n) => !nn.has(n.id)).map((n) => n.id),
    deleteEdgeKeys: prev.graph.edges.filter((e) => !ne.has(e.key)).map((e) => e.key),
    deleteChunkIds: prev.chunks.filter((c) => !nc.has(c.id)).map((c) => c.id),
  };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The graph after applying `delta`: same sorting, chunk metadata (no text) and version rule as a full build. */
export function applyDelta(graph: Graph, delta: GraphDelta): Graph {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = new Map(graph.edges.map((e) => [e.key, e]));
  const chunks = new Map(graph.chunks.map((c) => [c.id, c]));
  for (const id of delta.deleteNodeIds) nodes.delete(id);
  for (const k of delta.deleteEdgeKeys) edges.delete(k);
  for (const id of delta.deleteChunkIds) chunks.delete(id);
  for (const n of delta.upsertNodes) nodes.set(n.id, n);
  for (const e of delta.upsertEdges) edges.set(e.key, e);
  for (const c of delta.upsertChunks) chunks.set(c.id, { id: c.id, nodeId: c.nodeId, path: c.path, range: c.range });
  const sortedNodes = [...nodes.values()].sort((a, b) => cmp(a.id, b.id));
  const sortedEdges = [...edges.values()].sort((a, b) => cmp(a.key, b.key));
  return {
    version: graphVersion(sortedNodes.map((n) => n.id), sortedEdges.map((e) => e.key), sortedNodes.filter((n) => n.kind === 'file').map((n) => ({ path: n.path!, hash: n.fileHash }))),
    repoCommit: graph.repoCommit,
    nodes: sortedNodes,
    edges: sortedEdges,
    chunks: [...chunks.values()].sort((a, b) => cmp(a.id, b.id)),
  };
}

// ---------------------------------------------------------------- update

const deltaCounts = (d: GraphDelta): UpdateStats['delta'] => ({
  nodes: [d.upsertNodes.length, d.deleteNodeIds.length],
  edges: [d.upsertEdges.length, d.deleteEdgeKeys.length],
  chunks: [d.upsertChunks.length, d.deleteChunkIds.length],
});

async function fullRebuild(prev: IndexState, changed: number, reason: string, opts: BuildOptions, t0: number): Promise<UpdateResult> {
  const r = await buildIndex(prev.root, undefined, { ...(prev.coChange ? { coChange: prev.coChange } : {}), ...opts }); // re-profile from disk
  const t1 = performance.now();
  const delta = diffGraphs(prev, r.state);
  return {
    state: r.state,
    delta,
    stats: { changed, reExtracted: r.state.files.size, dependents: 0, fullRebuild: true, reason, delta: deltaCounts(delta), ms: { total: Math.round(performance.now() - t0), extract: r.stats.ms.extract, link: r.stats.ms.link, diff: Math.round(performance.now() - t1) } },
  };
}

export async function updateIndex(prev: IndexState, changes: readonly ChangedPath[], opts: BuildOptions = {}): Promise<UpdateResult> {
  const t0 = performance.now();
  const present = new Map<string, boolean>(); // repo-relative posix path → exists now
  for (const c of changes) {
    try {
      present.set(normPath(prev.root, c.path), c.status !== 'D');
    } catch {
      // a path outside the repo root is not ours
    }
  }
  const profileTouch = [...present.keys()].find(needsFullRebuild);
  if (profileTouch) return fullRebuild(prev, present.size, `${profileTouch} affects the profile`, opts, t0);

  // 1. file set, source files, extracts
  const allPaths = new Set(prev.allPaths);
  const files = new Map(prev.files);
  const extracts = new Map(prev.extracts);
  const loaded = new Map<string, SourceFile>();
  for (const [path, exists] of present) {
    if (exists) allPaths.add(path);
    else allPaths.delete(path);
    if (!isCandidate(path)) continue; // assets and ambient types only matter through allPaths
    files.delete(path);
    extracts.delete(path);
    if (!exists) continue;
    const f = await readSourceFile(prev.root, path, opts.maxBytes);
    if ('reason' in f) {
      if (f.reason === 'missing') allPaths.delete(path);
      continue; // too large / unreadable: exists, but not indexed (same as discovery)
    }
    loaded.set(path, f);
    files.set(path, { hash: f.hash, class: f.class });
  }

  // 2. global registrations: only files that had some, or that changed, can contribute
  const resolve = makeResolver(prev.profile, allPaths);
  const registrations = new Map<string, Registrations>(prev.registrations);
  for (const path of new Set([...prev.registrations.keys(), ...loaded.keys()])) {
    registrations.delete(path);
    if (!files.has(path)) continue;
    const f = loaded.get(path) ?? (await readSourceFile(prev.root, path, opts.maxBytes));
    if ('reason' in f) continue;
    const r = fileRegistrations(f, resolve);
    if (r) registrations.set(path, r);
  }
  const globals = mergeRegistrations(registrations);
  const globalsChanged = !same([...prev.globals].sort(([a], [b]) => cmp(a, b)), [...globals].sort(([a], [b]) => cmp(a, b)));

  // 3. which unchanged files must be re-extracted anyway?
  const dirty = new Set(loaded.keys());
  const dependents = new Set<string>();
  for (const [path, x] of extracts) {
    if (dirty.has(path)) continue;
    const stale = (globalsChanged && path.endsWith('.vue')) || x.imports.some((imp) => !same(resolve(imp.spec, path), imp.resolved));
    if (stale) {
      dirty.add(path);
      dependents.add(path);
    }
  }

  // 4. re-extract, then link everything and diff
  const t1 = performance.now();
  const ctx = makeExtractCtx(prev.root, prev.profile, allPaths, globals);
  for (const path of dirty) {
    const f = loaded.get(path) ?? (await readSourceFile(prev.root, path, opts.maxBytes));
    if ('reason' in f) {
      extracts.delete(path);
      files.delete(path);
      continue;
    }
    files.set(path, { hash: f.hash, class: f.class });
    extracts.set(path, extractFile(f, ctx));
  }
  const t2 = performance.now();
  const assembled = assembleGraph(extracts, files, await repoCommit(prev.root));
  const graph = withExtraEdges(assembled.graph, prev.extraEdges ?? []); // git co-change edges stay (pairs whose file vanished are dropped)
  const { chunks } = assembled;
  const t3 = performance.now();
  const delta = diffGraphs(prev, { graph, chunks });
  const t4 = performance.now();

  const state: IndexState = { ...prev, allPaths, files, registrations, globals, extracts: extracts as Map<string, FileExtract>, graph, chunks };
  return {
    state,
    delta,
    stats: { changed: present.size, reExtracted: dirty.size, dependents: dependents.size, fullRebuild: false, delta: deltaCounts(delta), ms: { total: Math.round(t4 - t0), extract: Math.round(t2 - t1), link: Math.round(t3 - t2), diff: Math.round(t4 - t3) } },
  };
}
