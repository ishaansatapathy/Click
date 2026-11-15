// PROMPTS 081 / SPEC §6.1: the graph as typed arrays, the shape personalised PageRank walks.
// Every edge becomes two arcs, one per direction, so "who depends on me" is as cheap as "what do I depend on".
// The structure is immutable once built and may be shared; weights (`w`, `wsum`) are added by weights.ts into
// NEW arrays, so a request that holds a Csr never sees it change.
//
//   offsets  Int32Array(N+1)   arcs of node u are [offsets[u], offsets[u+1])
//   targets  Int32Array(2E)    node index at the other end of the arc
//   edgeIdx  Int32Array(2E)    index into `edges` (to recover kind, key, learned multiplier)
//   dir      Uint8Array(2E)    0 = along the edge, 1 = against it
//   kind     Uint8Array(2E)    EDGE_KINDS index of the edge
//   w        Float32Array(2E)  effective weight (zeros until weights.ts fills it)
//   wsum     Float32Array(N)   sum of w over each node's arcs

import type { EdgeKind, Graph } from '../types.js';

export const EDGE_KINDS: readonly EdgeKind[] = [
  'contains', 'imports', 'uses_component', 'passes_prop', 'emits_to', 'calls',
  'uses_store', 'uses_composable', 'routes_to', 'has_type', 'tested_by', 'co_changed',
];
const KIND_INDEX: ReadonlyMap<EdgeKind, number> = new Map(EDGE_KINDS.map((k, i) => [k, i]));
const CO_CHANGED = EDGE_KINDS.indexOf('co_changed');
const KIND_SLOTS = 16; // 4 bits for the kind in the composite sort key
const NODE_LIMIT = 2 ** 23; // 23 bits per node index: (23 + 4 + 23) bits stay exact in a double

export interface CsrEdge {
  key: string;
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface Csr {
  readonly n: number;
  readonly ids: readonly string[];
  readonly index: ReadonlyMap<string, number>;
  readonly edges: readonly CsrEdge[]; // sorted by key, deduplicated
  readonly offsets: Int32Array;
  readonly targets: Int32Array;
  readonly edgeIdx: Int32Array;
  readonly dir: Uint8Array;
  readonly kind: Uint8Array;
  readonly w: Float32Array;
  readonly wsum: Float32Array;
  /** Input edges that were ignored: an endpoint is not in `ids`, or the edge is a self-loop. */
  readonly skipped: number;
}

export const arcCount = (csr: Csr): number => csr.targets.length;

/**
 * Indices 0..n-1 ordered by (hi, lo), ascending, stable. LSD radix sort, 2 passes over lo (12 + 11 bits) and 3 over hi
 * (9 bits each): five counting passes, linear in n.
 */
function radixOrder(hi: Int32Array, lo: Int32Array, n: number): Int32Array {
  let a = new Int32Array(n);
  let b = new Int32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  const pass = (keys: Int32Array, shift: number, bits: number): void => {
    const radix = 1 << bits;
    const mask = radix - 1;
    const count = new Int32Array(radix + 1);
    for (let i = 0; i < n; i++) count[((keys[a[i]!]! >>> shift) & mask) + 1]!++;
    for (let r = 0; r < radix; r++) count[r + 1]! += count[r]!;
    for (let i = 0; i < n; i++) {
      const p = a[i]!;
      b[count[(keys[p]! >>> shift) & mask]!++] = p;
    }
    [a, b] = [b, a];
  };
  pass(lo, 0, 12);
  pass(lo, 12, 11);
  pass(hi, 0, 9);
  pass(hi, 9, 9);
  pass(hi, 18, 9);
  return a;
}

/**
 * Build a Csr over `ids` (node order = given order; pass them sorted for stable indices) and `edges`.
 * Output depends only on the SET of edges: they are sorted by key and deduplicated first, so HydraDB rows arriving in
 * any order give identical arrays (and therefore identical PageRank results).
 */
export function buildCsr(ids: readonly string[], edges: readonly CsrEdge[]): Csr {
  const index = new Map<string, number>();
  ids.forEach((id, i) => {
    if (!index.has(id)) index.set(id, i);
  });
  const n = ids.length;

  if (n >= NODE_LIMIT) throw new Error(`graph too large for the CSR: ${n} nodes (limit ${NODE_LIMIT})`);

  // Order and dedupe edges by (from, kind, to) with an LSD radix sort on integers: no string comparisons, no Map of
  // 200k keys. The result depends only on the SET of edges (and on the order of `ids`). co_changed is symmetric, so
  // its endpoints are put in index order first. Radix sorting is stable, so among duplicates the first one given wins.
  const hi = new Int32Array(edges.length); // from * 16 + kind   (< 2^27)
  const lo = new Int32Array(edges.length); // to                 (< 2^23)
  const src = new Int32Array(edges.length); // position in `edges`
  let cnt = 0;
  let skipped = 0; // duplicates are the same edge, not "skipped"
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    let a = index.get(e.from);
    let b = index.get(e.to);
    const k = KIND_INDEX.get(e.kind);
    if (a === undefined || b === undefined || a === b || k === undefined) {
      skipped++;
      continue;
    }
    if (k === CO_CHANGED && a > b) [a, b] = [b, a];
    hi[cnt] = a * KIND_SLOTS + k;
    lo[cnt] = b;
    src[cnt] = i;
    cnt++;
  }
  const order = radixOrder(hi, lo, cnt);

  const ea = new Int32Array(cnt);
  const eb = new Int32Array(cnt);
  const ek = new Uint8Array(cnt);
  const finalEdges: CsrEdge[] = [];
  const deg = new Int32Array(n + 1);
  let m = 0;
  let prevHi = -1;
  let prevLo = -1;
  for (let t = 0; t < cnt; t++) {
    const p = order[t]!;
    const h = hi[p]!;
    const l = lo[p]!;
    if (h === prevHi && l === prevLo) continue; // duplicate of the previous (from, kind, to)
    prevHi = h;
    prevLo = l;
    const k = h % KIND_SLOTS;
    const a = (h - k) / KIND_SLOTS;
    ea[m] = a;
    eb[m] = l;
    ek[m] = k;
    finalEdges.push(edges[src[p]!]!);
    deg[a + 1]!++;
    deg[l + 1]!++;
    m++;
  }
  for (let i = 0; i < n; i++) deg[i + 1]! += deg[i]!;
  const offsets = deg;
  const arcs = m * 2;
  const targets = new Int32Array(arcs);
  const edgeIdx = new Int32Array(arcs);
  const dir = new Uint8Array(arcs);
  const kind = new Uint8Array(arcs);
  const cursor = Int32Array.from(offsets.subarray(0, n));
  for (let j = 0; j < m; j++) {
    const a = ea[j]!;
    const b = eb[j]!;
    let p = cursor[a]!++;
    targets[p] = b; edgeIdx[p] = j; dir[p] = 0; kind[p] = ek[j]!;
    p = cursor[b]!++;
    targets[p] = a; edgeIdx[p] = j; dir[p] = 1; kind[p] = ek[j]!;
  }

  return { n, ids, index, edges: finalEdges, offsets, targets, edgeIdx, dir, kind, w: new Float32Array(arcs), wsum: new Float32Array(n), skipped };
}

/** Csr over a whole graph. `extra` edges (e.g. learned co_changed edges) are merged in; ids are sorted for stable indices. */
export function csrFromGraph(graph: Pick<Graph, 'nodes' | 'edges'>, extra: readonly CsrEdge[] = []): Csr {
  const ids = graph.nodes.map((n) => n.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return buildCsr(ids, [...graph.edges, ...extra]);
}

/** Csr over just the nodes that appear in `edges` (a subgraph fetched from HydraDB). Ids are sorted for stable indices. */
export function csrFromEdges(edges: readonly CsrEdge[], seeds: readonly string[] = []): Csr {
  const ids = [...new Set([...seeds, ...edges.flatMap((e) => [e.from, e.to])])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return buildCsr(ids, edges);
}
