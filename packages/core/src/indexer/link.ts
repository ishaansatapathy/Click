// PROMPTS 056: turns per-file extracts into one graph.
//   - SymbolRefs (file A uses `name` exported by file B) become edges between real node ids, following barrel
//     re-exports up to 3 hops (`export { x } from`, `export * from`, `export { default as X } from`, `export * as ns`);
//   - the edge KIND is re-derived from the target node, so a misleading name never produces a wrong kind
//     (a `calls` ref to a Pinia store is `uses_store`; `uses_store` aimed at a plain function is `calls`);
//   - `emits_to` and `tested_by` refs are recorded on the using side and reversed here (child → parent, symbol → test);
//   - route tables are finalised (nested paths joined, imported path consts looked up in other files) into route nodes;
//   - nothing throws: an unresolvable ref falls back to the target's file node, or is counted and dropped.
// Deterministic: nodes, edges and chunks come out sorted.

import type { FileExtract, SymbolRef } from '../contracts.js';
import type { ChunkRecord, EdgeKind, GraphEdge, GraphNode } from '../types.js';
import { edgeKey, fileId } from '../util/ids.js';
import { finalizeRoutes } from './router.js';

const MAX_HOPS = 3;
const REVERSED: ReadonlySet<EdgeKind> = new Set<EdgeKind>(['emits_to', 'tested_by']);

export interface LinkInput {
  extracts: ReadonlyMap<string, FileExtract>;
  /** path → file hash, for route nodes (their fileHash is the router file's). */
  fileHashes: ReadonlyMap<string, string>;
}

export interface LinkStats {
  refs: number;
  resolved: number; // landed on a real symbol node
  fileFallback: number; // landed on the target's file node
  dropped: number; // had no usable target
  droppedByReason: Record<string, number>;
  routes: number;
  unresolvedRoutePaths: string[];
}

export interface LinkResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  chunks: ChunkRecord[];
  stats: LinkStats;
}

interface Exports {
  named: Map<string, string>;
  default?: string;
}

const byKey = <T>(key: (x: T) => string) => (a: T, b: T): number => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

export function link(input: LinkInput): LinkResult {
  const nodes = new Map<string, GraphNode>();
  const exportsByPath = new Map<string, Exports>();
  for (const x of input.extracts.values()) {
    for (const n of x.nodes) {
      if (!nodes.has(n.id)) nodes.set(n.id, n);
      if (n.path === null || n.kind === 'file' || n.kind === 'test') continue;
      const ex = exportsByPath.get(n.path) ?? { named: new Map<string, string>() };
      if (n.kind === 'component') ex.default = n.id; // a .vue file's default export
      else {
        if (n.meta?.parent === undefined) ex.named.set(n.name, n.id);
        if (n.meta?.isDefault === true) ex.default = n.id;
      }
      exportsByPath.set(n.path, ex);
    }
  }

  /** Node id exported as `name` ('default' | name | '*') by the module at `path`, following re-exports. */
  const resolveExport = (path: string, name: string, depth = 0): string | null => {
    if (name === '*') return nodes.has(fileId(path)) ? fileId(path) : null;
    if (depth > MAX_HOPS) return null;
    const own = name === 'default' ? exportsByPath.get(path)?.default : exportsByPath.get(path)?.named.get(name);
    if (own) return own;
    const x = input.extracts.get(path);
    if (!x) return null;
    for (const imp of x.imports) {
      if (imp.kind !== 'reexport' || imp.resolved.kind !== 'local') continue;
      for (const n of imp.names) {
        let hit: string | null = null;
        if (n.imported === '*' && n.local === '*') hit = name === 'default' ? null : resolveExport(imp.resolved.path, name, depth + 1); // export * from
        else if (n.imported === '*' && n.local === name) hit = nodes.has(fileId(imp.resolved.path)) ? fileId(imp.resolved.path) : null; // export * as name
        else if (n.local === name) hit = resolveExport(imp.resolved.path, n.imported, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };

  const edges = new Map<string, GraphEdge>();
  const stats: LinkStats = { refs: 0, resolved: 0, fileFallback: 0, dropped: 0, droppedByReason: {}, routes: 0, unresolvedRoutePaths: [] };
  const drop = (reason: string): void => {
    stats.dropped++;
    stats.droppedByReason[reason] = (stats.droppedByReason[reason] ?? 0) + 1;
  };
  const addEdge = (from: string, kind: EdgeKind, to: string, meta?: GraphEdge['meta']): void => {
    if (from === to) return;
    const key = edgeKey(from, kind, to);
    const prev = edges.get(key);
    if (!prev) {
      edges.set(key, { key, from, to, kind, ...(meta ? { meta } : {}) });
      return;
    }
    const union = (a?: string[], b?: string[]) => [...new Set([...(a ?? []), ...(b ?? [])])];
    if (meta?.props || meta?.events) {
      prev.meta = { ...prev.meta, ...(meta.props || prev.meta?.props ? { props: union(prev.meta?.props, meta.props) } : {}), ...(meta.events || prev.meta?.events ? { events: union(prev.meta?.events, meta.events) } : {}) };
    }
  };

  const finalKind = (kind: EdgeKind, target: GraphNode): EdgeKind | null => {
    if (kind === 'has_type') return target.kind === 'type' ? 'has_type' : null;
    if (kind === 'uses_store' || kind === 'uses_composable' || kind === 'calls') {
      if (target.kind === 'store') return 'uses_store';
      if (target.kind === 'composable') return 'uses_composable';
      return 'calls';
    }
    return kind;
  };

  const linkRef = (ref: SymbolRef): void => {
    stats.refs++;
    let id = resolveExport(ref.targetPath, ref.targetName);
    let fallback = false;
    if (!id && nodes.has(fileId(ref.targetPath))) {
      id = fileId(ref.targetPath);
      fallback = true;
    }
    const target = id ? nodes.get(id) : undefined;
    if (!id || !target) return drop('target-not-found');
    if (!nodes.has(ref.from)) return drop('source-missing');
    const kind = finalKind(ref.kind, target);
    if (!kind) return drop('not-a-type');
    if (fallback) stats.fileFallback++;
    else stats.resolved++;
    const meta = { source: 'ast' as const, ...ref.meta };
    if (REVERSED.has(kind)) addEdge(id, kind, ref.from, meta);
    else addEdge(ref.from, kind, id, meta);
  };

  // 1. edges that were already final inside each file
  for (const x of input.extracts.values()) for (const e of x.edges) addEdge(e.from, e.kind, e.to, e.meta);
  // 2. cross-file refs
  for (const x of input.extracts.values()) for (const r of x.refs) linkRef(r);

  // 3. routes: join paths, look up imported path consts, add nodes, then resolve their component refs
  const constValue = (path: string, name: string): string | undefined => {
    const id = resolveExport(path, name);
    const v = id ? nodes.get(id)?.meta?.value : undefined;
    return typeof v === 'string' ? v : undefined;
  };
  for (const [path, x] of input.extracts) {
    if (x.routes.length === 0) continue;
    const fin = finalizeRoutes(x.routes, path, input.fileHashes.get(path) ?? '', constValue);
    stats.unresolvedRoutePaths.push(...fin.unresolvedPaths);
    for (const n of fin.nodes) {
      if (nodes.has(n.id)) continue;
      nodes.set(n.id, n);
      stats.routes++;
      if (nodes.has(fileId(path))) addEdge(fileId(path), 'contains', n.id, { source: 'ast' });
    }
    fin.refs.forEach(linkRef);
  }

  // Dangling endpoints (e.g. an import of a file that was skipped as too large) are dropped, never emitted.
  const finalEdges = [...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to));
  const chunks: ChunkRecord[] = [...input.extracts.values()].flatMap((x) => x.chunks);
  return {
    nodes: [...nodes.values()].sort(byKey((n: GraphNode) => n.id)),
    edges: finalEdges.sort(byKey((e: GraphEdge) => e.key)),
    chunks: chunks.sort(byKey((c: ChunkRecord) => c.id)),
    stats,
  };
}
