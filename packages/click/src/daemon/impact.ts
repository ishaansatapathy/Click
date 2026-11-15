// PROMPTS 171 / 172 / SPEC §10: `GET /impact?symbol=&depth=3` ("what breaks if I change X?") and `GET /conventions`.
//   impact       the nodes that DEPEND on a symbol, found by walking incoming dependency edges up to 3 hops (imports, uses_component,
//                uses_store, uses_composable, calls, routes_to, passes_prop), plus the tests that cover the symbol or any dependent
//                (tested_by edges point from the code to its test, so tests are read off the outgoing side).
//                HydraDB does the walk (GraphStore.impact, a shortest-path query over incoming edges) within 400 ms; if it is down, slow
//                or empty, the same walk runs on the local replica. Every item carries the edge chain that connects it to the symbol.
//   conventions  the conventions that are current now (validTo == null), with the date they started.

import { z } from 'zod';
import type { Convention, EdgeKind, Graph, GraphNode } from '../../../core/src/types.js';
import type { GraphStore, Store } from '../../../core/src/store/types.js';
import { withDeadline } from '../../../core/src/util/deadline.js';
import type { Lexical } from '../../../core/src/pipeline.js';
import type { DaemonState } from './boot.js';
import type { Route } from './server.js';

export const MAX_DEPTH = 3;
/** Edge kinds along which "A depends on B" is read from A to B; walking them backwards from B finds what a change to B can break. */
export const DEPENDENCY_KINDS: readonly EdgeKind[] = ['imports', 'uses_component', 'uses_store', 'uses_composable', 'calls', 'routes_to', 'passes_prop'];
const IMPACT_TIMEOUT_MS = 400;
const MAX_ITEMS = 200;

export interface ImpactItem {
  nodeId: string;
  path: string | null;
  name: string;
  kind: GraphNode['kind'];
  /** Edge keys from this node down to the symbol, nearest the node first: `from|kind|to`. */
  chain: string[];
  /** Hops from the symbol. */
  distance: number;
}

export interface ImpactGroups {
  components: ImpactItem[];
  stores: ImpactItem[];
  composables: ImpactItem[];
  routes: ImpactItem[];
  tests: ImpactItem[];
  other: ImpactItem[];
}

export interface ImpactResult {
  symbol: string;
  resolved: { nodeId: string; name: string; path: string | null; kind: GraphNode['kind'] } | null;
  depth: number;
  source: 'hydra' | 'replica' | null;
  count: number;
  groups: ImpactGroups;
}

const empty = (): ImpactGroups => ({ components: [], stores: [], composables: [], routes: [], tests: [], other: [] });
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- resolving a name

/** A node id, an exact name, a name ignoring case, or the best lexical / symbol match, in that order. */
export function resolveSymbol(query: string, graph: Pick<Graph, 'nodes'>, lexical: Lexical | null): GraphNode | null {
  const q = query.trim();
  if (!q) return null;
  const byId = graph.nodes.find((n) => n.id === q);
  if (byId) return byId;
  const rank = (n: GraphNode): number => ['store', 'component', 'composable', 'function', 'type', 'route', 'file', 'test'].indexOf(n.kind);
  const pick = (list: GraphNode[]): GraphNode | null => [...list].sort((a, b) => rank(a) - rank(b) || cmp(a.id, b.id))[0] ?? null;
  const exact = graph.nodes.filter((n) => n.kind !== 'chunk' && n.name === q);
  if (exact.length) return pick(exact);
  const lower = q.toLowerCase();
  const loose = graph.nodes.filter((n) => n.kind !== 'chunk' && n.name.toLowerCase() === lower);
  if (loose.length) return pick(loose);
  const byPath = graph.nodes.filter((n) => n.kind === 'file' && (n.path === q || n.path?.endsWith(`/${q}`)));
  if (byPath.length) return pick(byPath);
  const hit = lexical?.symbols.match(q, 1)[0] ?? lexical?.bm25.search(q, 1)[0];
  return hit ? (graph.nodes.find((n) => n.id === hit.id) ?? null) : null;
}

// ---------------------------------------------------------------- the walk

interface Found {
  nodeId: string;
  chain: string[];
}

/** Breadth-first over incoming dependency edges: nearest dependents first, each node once, with the edges that lead from it to `id`. */
export function replicaImpact(graph: Pick<Graph, 'edges'>, id: string, depth: number): Found[] {
  const incoming = new Map<string, { from: string; key: string }[]>();
  const kinds = new Set<EdgeKind>(DEPENDENCY_KINDS);
  for (const e of graph.edges) {
    if (!kinds.has(e.kind)) continue;
    (incoming.get(e.to) ?? incoming.set(e.to, []).get(e.to)!).push({ from: e.from, key: e.key });
  }
  for (const list of incoming.values()) list.sort((a, b) => cmp(a.from, b.from) || cmp(a.key, b.key));
  const seen = new Set([id]);
  const out: Found[] = [];
  let level: Found[] = [{ nodeId: id, chain: [] }];
  for (let d = 0; d < depth && level.length; d++) {
    const next: Found[] = [];
    for (const cur of level) {
      for (const e of incoming.get(cur.nodeId) ?? []) {
        if (seen.has(e.from)) continue;
        seen.add(e.from);
        const f = { nodeId: e.from, chain: [e.key, ...cur.chain] };
        out.push(f);
        next.push(f);
      }
    }
    level = next;
  }
  return out;
}

/** HydraDB's answer (node-id paths from dependent to the symbol) as chains of edge keys. */
function fromHydra(rows: { path: string[]; kinds: EdgeKind[] }[]): Found[] {
  const seen = new Set<string>();
  const out: Found[] = [];
  for (const r of rows) {
    const head = r.path[0];
    if (!head || seen.has(head)) continue; // nearest first: the first path to a node is its shortest
    seen.add(head);
    out.push({ nodeId: head, chain: r.kinds.map((k, i) => `${r.path[i]}|${k}|${r.path[i + 1]}`) });
  }
  return out;
}

const bucket = (n: GraphNode): keyof ImpactGroups => {
  switch (n.kind) {
    case 'component': return 'components';
    case 'store': return 'stores';
    case 'composable': return 'composables';
    case 'route': return 'routes';
    case 'test': return 'tests';
    default: return 'other';
  }
};

export async function computeImpact(
  query: string,
  depthIn: number,
  d: { graph: Graph; lexical: Lexical | null; store: GraphStore | null; timeoutMs?: number },
): Promise<ImpactResult> {
  const depth = Math.min(MAX_DEPTH, Math.max(1, Math.floor(depthIn)));
  const target = resolveSymbol(query, d.graph, d.lexical);
  if (!target) return { symbol: query, resolved: null, depth, source: null, count: 0, groups: empty() };

  let found: Found[] | null = null;
  let source: 'hydra' | 'replica' = 'replica';
  if (d.store) {
    const ctrl = new AbortController();
    try {
      const rows = await withDeadline(d.store.impact(target.id, { maxHops: depth, kinds: [...DEPENDENCY_KINDS], limit: MAX_ITEMS * 3 }, ctrl.signal), d.timeoutMs ?? IMPACT_TIMEOUT_MS, () => {
        ctrl.abort();
        return null;
      });
      if (rows && rows.length > 0) {
        found = fromHydra(rows);
        source = 'hydra';
      }
    } catch {
      // fall back to the replica below
    }
  }
  found ??= replicaImpact(d.graph, target.id, depth);

  const nodes = new Map(d.graph.nodes.map((n) => [n.id, n]));
  // tests: tested_by edges run from the code to its test, so read them off the symbol and its dependents
  const testsOf = new Map<string, { to: string; key: string }[]>();
  for (const e of d.graph.edges) if (e.kind === 'tested_by') (testsOf.get(e.from) ?? testsOf.set(e.from, []).get(e.from)!).push({ to: e.to, key: e.key });
  const items = new Map<string, ImpactItem>();
  const add = (nodeId: string, chain: string[]): void => {
    const n = nodes.get(nodeId);
    if (!n || nodeId === target.id || items.has(nodeId)) return;
    items.set(nodeId, { nodeId, path: n.path, name: n.name, kind: n.kind, chain, distance: chain.length });
  };
  for (const f of found) add(f.nodeId, f.chain);
  for (const f of [{ nodeId: target.id, chain: [] as string[] }, ...found]) {
    for (const t of testsOf.get(f.nodeId) ?? []) add(t.to, [t.key, ...f.chain]);
  }

  // a file that merely imports the symbol duplicates the component or function inside it: keep the file only when nothing in it is listed
  const covered = new Set([...items.values()].filter((i) => i.kind !== 'file' && i.path).map((i) => i.path!));
  const list = [...items.values()]
    .filter((i) => !(i.kind === 'file' && i.path && covered.has(i.path)))
    .sort((a, b) => a.distance - b.distance || cmp(a.path ?? '', b.path ?? '') || cmp(a.name, b.name))
    .slice(0, MAX_ITEMS);

  const groups = empty();
  for (const i of list) groups[bucket(nodes.get(i.nodeId)!)].push(i);
  return { symbol: query, resolved: { nodeId: target.id, name: target.name, path: target.path, kind: target.kind }, depth, source, count: list.length, groups };
}

// ---------------------------------------------------------------- routes

const impactQuery = z.object({ symbol: z.string().min(1).max(300), depth: z.coerce.number().int().min(1).max(MAX_DEPTH).default(MAX_DEPTH) });

export function impactRoutes(d: { state: DaemonState; graph: GraphStore | null; store: Store }): Route[] {
  return [
    {
      method: 'GET',
      path: '/impact',
      async handle({ query }) {
        const q = impactQuery.parse({ symbol: query.get('symbol') ?? undefined, ...(query.get('depth') ? { depth: query.get('depth') } : {}) });
        const holder = d.state.status === 'ready' ? d.state.holder : null;
        if (!holder) return { ok: true, status: 'warming', symbol: q.symbol, resolved: null, depth: q.depth, source: null, count: 0, groups: empty() };
        const st = holder.current();
        return { ok: true, ...(await computeImpact(q.symbol, q.depth, { graph: st.graph, lexical: st.lexical, store: d.graph })) };
      },
    },
    {
      method: 'GET',
      path: '/conventions',
      async handle() {
        const all: Convention[] = await d.store.getConventions();
        return { ok: true, items: all.filter((c) => c.validTo === null).sort((a, b) => cmp(a.validFrom, b.validFrom) || cmp(a.id, b.id)) };
      },
    },
  ];
}
