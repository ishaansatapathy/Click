// PROMPTS 060 / 061: `click map` — look at the graph the indexer built.
//   click map [--stats]            what is in the graph, hubs, orphans, unresolved imports (the first check when retrieval misses)
//   click map --node <id|name>     one node's neighbours in both directions, with the weight the ranker would use
//   click map --path <file>        everything in one file
// Options: --root <dir> (default: cwd), --no-cache.

import { join } from 'node:path';
import { buildIndex, type BuildResult } from '../../../core/src/indexer/build.js';
import { effectiveWeight } from '../../../core/src/graph/priors.js';
import type { Graph, GraphEdge, GraphNode } from '../../../core/src/types.js';
import { clickDir } from '../../../core/src/util/paths.js';

export interface MapIo {
  out: (text: string) => void;
  err: (text: string) => void;
  cacheDir?: string;
  now?: () => Date;
}

const pad = (s: string | number, n: number): string => String(s).padEnd(n);
const padL = (s: string | number, n: number): string => String(s).padStart(n);
const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;

// ---------------------------------------------------------------- stats

interface Degrees {
  inDeg: Map<string, number>;
  outDeg: Map<string, number>;
}

/** Degrees over semantic edges: `contains` only says "this file declares that symbol", so it is excluded. */
function degrees(graph: Graph): Degrees {
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.kind === 'contains') continue;
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }
  return { inDeg, outDeg };
}

export function formatStats(r: BuildResult): string {
  const { graph, stats } = r;
  const { inDeg, outDeg } = degrees(graph);
  const L: string[] = [];
  L.push(`Graph ${graph.version}  ·  ${stats.files} files  ·  ${graph.nodes.length} nodes  ·  ${graph.edges.length} edges  ·  ${graph.chunks.length} chunks`);
  L.push(`Built in ${stats.ms.total} ms (discover ${stats.ms.discover}, extract ${stats.ms.extract}, link ${stats.ms.link}; extract cache ${stats.extractCacheHits} hit / ${stats.extractCacheMisses} miss)`);
  L.push(`Files by class: ${Object.entries(stats.byClass).map(([k, v]) => `${k} ${v}`).join(', ')}${stats.skipped.length ? `  ·  skipped ${stats.skipped.length}` : ''}`);

  L.push('', 'Nodes by kind');
  for (const [k, v] of Object.entries(stats.nodesByKind)) L.push(`  ${pad(k, 12)} ${padL(v, 6)}`);
  L.push('', 'Edges by kind');
  for (const [k, v] of Object.entries(stats.edgesByKind)) L.push(`  ${pad(k, 16)} ${padL(v, 6)}`);

  const hubs = graph.nodes
    .filter((n) => n.kind !== 'file' && (inDeg.get(n.id) ?? 0) > 0)
    .sort((a, b) => (inDeg.get(b.id) ?? 0) - (inDeg.get(a.id) ?? 0) || (a.id < b.id ? -1 : 1))
    .slice(0, 15);
  L.push('', 'Top 15 hubs (most incoming edges, `contains` excluded)');
  for (const n of hubs) L.push(`  ${padL(inDeg.get(n.id) ?? 0, 4)} in  ${padL(outDeg.get(n.id) ?? 0, 4)} out  ${pad(n.kind, 11)} ${n.id}`);

  const orphans = graph.nodes.filter((n) => (inDeg.get(n.id) ?? 0) + (outDeg.get(n.id) ?? 0) === 0);
  const orphanKinds = Object.entries(orphans.reduce<Record<string, number>>((a, n) => ((a[n.kind] = (a[n.kind] ?? 0) + 1), a), {})).map(([k, v]) => `${k} ${v}`).join(', ');
  L.push('', `Orphans (no edge except \`contains\`): ${orphans.length}${orphans.length ? `  (${orphanKinds})` : ''}`);
  for (const n of orphans.slice(0, 10)) L.push(`  ${pad(n.kind, 11)} ${n.id}`);
  if (orphans.length > 10) L.push(`  … ${orphans.length - 10} more`);

  const { local, external, unresolved } = stats.imports;
  L.push('', `Imports: ${local} repo-local, ${external} external, ${unresolved} unresolved`);
  L.push(`Unresolved local imports: ${unresolved} of ${local + unresolved} (${pct(stats.unresolvedLocalRatio)})  [gate: < 2%]`);
  for (const u of stats.unresolvedSpecs.slice(0, 20)) L.push(`  ${padL(u.count, 4)}  ${u.spec}`);

  const l = stats.link;
  L.push('', `Links: ${l.refs} cross-file refs → ${l.resolved} resolved, ${l.fileFallback} to a file node, ${l.dropped} dropped${l.dropped ? ` (${Object.entries(l.droppedByReason).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
  if (l.unresolvedRoutePaths.length) L.push(`Route paths that could not be resolved: ${l.unresolvedRoutePaths.join(', ')}`);
  L.push(`Conventions: ${r.conventions.length}`);
  return L.join('\n');
}

// ---------------------------------------------------------------- node lookup

export type Lookup = { kind: 'one'; node: GraphNode } | { kind: 'many'; nodes: GraphNode[] } | { kind: 'none' };

const KIND_RANK: Record<string, number> = { component: 0, store: 1, composable: 2, route: 3, function: 4, type: 5, test: 6, file: 7 };

/** Exact id → exact name → case-insensitive name → substring of id. One hit wins; several are returned as candidates. */
export function resolveNode(graph: Graph, query: string): Lookup {
  const q = query.trim();
  const byId = graph.nodes.find((n) => n.id === q);
  if (byId) return { kind: 'one', node: byId };
  const tiers: ((n: GraphNode) => boolean)[] = [
    (n) => n.name === q,
    (n) => n.name.toLowerCase() === q.toLowerCase(),
    (n) => n.id.toLowerCase().includes(q.toLowerCase()),
  ];
  for (const t of tiers) {
    const hits = graph.nodes.filter(t).sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || a.id.length - b.id.length || (a.id < b.id ? -1 : 1));
    if (hits.length === 1) return { kind: 'one', node: hits[0]! };
    if (hits.length > 1) return { kind: 'many', nodes: hits };
  }
  return { kind: 'none' };
}

// ---------------------------------------------------------------- node view

const MAX_LINES = 40;
const where = (n: GraphNode): string => (n.path ? `${n.path}${n.range ? `:${n.range.startLine}-${n.range.endLine}` : ''}` : '');

function describe(n: GraphNode): string[] {
  const L = [`${n.id}  [${n.kind}]  ${where(n)}  (${n.tokens} tokens)`];
  if (n.signature) L.push(`  ${n.signature}`);
  if (n.doc) L.push(`  doc: ${n.doc}`);
  const m = n.meta ?? {};
  const list = (k: string): string => (Array.isArray(m[k]) && (m[k] as unknown[]).length ? (m[k] as string[]).join(', ') : '');
  const parts = (['props', 'emits', 'slots', 'state', 'getters', 'actions', 'returns'] as const).map((k) => (list(k) ? `${k}: ${list(k)}` : '')).filter(Boolean);
  if (parts.length) L.push(`  ${parts.join(' · ')}`);
  return L;
}

function edgeLine(arrow: '→' | '←', e: GraphEdge, other: GraphNode | undefined, w: number): string {
  const extra = e.meta?.props?.length ? `  props: ${e.meta.props.join(',')}` : e.meta?.events?.length ? `  events: ${e.meta.events.join(',')}` : '';
  return `  ${arrow} ${pad(e.kind, 16)} w=${w.toFixed(2)}  ${other?.id ?? (arrow === '→' ? e.to : e.from)}${other ? `  [${other.kind}]` : ''}${extra}`;
}

export function formatNode(graph: Graph, node: GraphNode): string {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = graph.edges.filter((e) => e.from === node.id);
  const inc = graph.edges.filter((e) => e.to === node.id);
  const rows = (es: GraphEdge[], dir: 'out' | 'in') =>
    es
      .map((e) => ({ e, w: effectiveWeight(e.kind, dir), other: byId.get(dir === 'out' ? e.to : e.from) }))
      .sort((a, b) => b.w - a.w || (a.e.key < b.e.key ? -1 : 1));
  const L = describe(node);
  const emit = (title: string, items: ReturnType<typeof rows>, arrow: '→' | '←') => {
    L.push('', `${title} (${items.length})   w = weight of walking this way: prior × ${arrow === '←' ? 'reverse factor' : '1'}`);
    for (const it of items.slice(0, MAX_LINES)) L.push(edgeLine(arrow, it.e, it.other, it.w));
    if (items.length > MAX_LINES) L.push(`  … ${items.length - MAX_LINES} more`);
  };
  emit('Outgoing', rows(out, 'out'), '→');
  emit('Incoming', rows(inc, 'in'), '←');
  return L.join('\n');
}

export function formatCandidates(query: string, nodes: GraphNode[]): string {
  const L = [`"${query}" matches ${nodes.length} nodes; pass one of these ids:`];
  for (const n of nodes.slice(0, 15)) L.push(`  ${pad(n.kind, 11)} ${n.id}`);
  if (nodes.length > 15) L.push(`  … ${nodes.length - 15} more`);
  return L.join('\n');
}

// ---------------------------------------------------------------- file view

export function formatPath(graph: Graph, path: string): string {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '');
  const nodes = graph.nodes.filter((n) => n.path === p).sort((a, b) => (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) || (a.id < b.id ? -1 : 1));
  if (nodes.length === 0) return '';
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const L = [`${p}  ·  ${nodes.length} nodes`];
  for (const n of nodes) {
    const out = graph.edges.filter((e) => e.from === n.id && e.kind !== 'contains');
    const inc = graph.edges.filter((e) => e.to === n.id && e.kind !== 'contains');
    const count = (es: GraphEdge[]) => Object.entries(es.reduce<Record<string, number>>((a, e) => ((a[e.kind] = (a[e.kind] ?? 0) + 1), a), {})).map(([k, v]) => `${k}×${v}`).join(' ');
    L.push('', `${pad(n.kind, 11)} ${n.name}${n.range ? `  L${n.range.startLine}-${n.range.endLine}` : ''}`);
    if (n.signature) L.push(`  ${n.signature}`);
    if (out.length) L.push(`  out: ${count(out)}`);
    if (inc.length) L.push(`  in:  ${count(inc)}`);
  }
  const fileNode = nodes.find((n) => n.kind === 'file');
  if (fileNode) {
    const imp = (dir: 'out' | 'in') =>
      graph.edges.filter((e) => e.kind === 'imports' && (dir === 'out' ? e.from === fileNode.id : e.to === fileNode.id)).map((e) => byId.get(dir === 'out' ? e.to : e.from)?.path ?? '?').sort();
    L.push('', `Imports (${imp('out').length}): ${imp('out').join(', ') || '—'}`, `Imported by (${imp('in').length}): ${imp('in').join(', ') || '—'}`);
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- command

interface Args {
  mode: 'stats' | 'node' | 'path';
  value?: string;
  root: string;
  cache: boolean;
}

export function parseMapArgs(argv: readonly string[], cwd: string): Args | string {
  const a: Args = { mode: 'stats', root: cwd, cache: true };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]!;
    const v = () => argv[++i];
    if (f === '--stats') a.mode = 'stats';
    else if (f === '--node' || f === '--path') {
      const val = v();
      if (!val) return `${f} needs a value`;
      a.mode = f === '--node' ? 'node' : 'path';
      a.value = val;
    } else if (f === '--root') {
      const val = v();
      if (!val) return '--root needs a directory';
      a.root = val;
    } else if (f === '--no-cache') a.cache = false;
    else return `unknown option ${f}`;
  }
  return a;
}

export const MAP_USAGE = 'usage: click map [--stats | --node <id|name> | --path <file>] [--root <dir>] [--no-cache]';

/** Returns the process exit code. */
export async function runMap(argv: readonly string[], io: MapIo, cwd: string = process.cwd()): Promise<number> {
  const args = parseMapArgs(argv, cwd);
  if (typeof args === 'string') {
    io.err(`${args}\n${MAP_USAGE}`);
    return 2;
  }
  const r = await buildIndex(args.root, undefined, { cache: args.cache, cacheDir: io.cacheDir ?? join(clickDir(args.root), 'cache'), ...(io.now ? { now: io.now } : {}) });
  if (args.mode === 'stats') {
    io.out(formatStats(r));
    return 0;
  }
  if (args.mode === 'node') {
    const hit = resolveNode(r.graph, args.value!);
    if (hit.kind === 'one') {
      io.out(formatNode(r.graph, hit.node));
      return 0;
    }
    if (hit.kind === 'many') {
      io.out(formatCandidates(args.value!, hit.nodes));
      return 0;
    }
    io.err(`no node matches "${args.value}". Try \`click map --stats\` for hubs, or a path with --path.`);
    return 1;
  }
  const text = formatPath(r.graph, args.value!);
  if (!text) {
    io.err(`no indexed file at "${args.value}" (paths are relative to ${args.root}).`);
    return 1;
  }
  io.out(text);
  return 0;
}
