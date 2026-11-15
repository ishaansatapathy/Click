// PROMPTS 093 / SPEC §9.3: the stable part of the context. Off in Stage 1 presets, on for `delivery`.
//   conventions  the current ones (validTo == null), one line each
//   skeleton     signatures of the top 15 hubs by global PageRank, computed once per graph version and cached.
//                HydraDB computes PageRank (GraphStore.hubs); if it is unreachable or slow, the same ranking is computed
//                locally on the replica (uniform teleport), so the prefix never depends on the network.

import type { Csr } from '../graph/csr.js';
import type { GraphStore } from '../store/types.js';
import type { Convention, GraphNode } from '../types.js';
import { withDeadline } from '../util/deadline.js';

export const SKELETON_SIZE = 15;
const HUB_OVERFETCH = 60; // hubs are often files and containers; ask for more than we keep
const SKELETON_KINDS: ReadonlySet<string> = new Set(['function', 'component', 'composable', 'store', 'type']);

export function conventionLines(conventions: readonly Convention[]): string[] {
  return conventions
    .filter((c) => c.validTo === null)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => `- ${c.text.replace(/\s+/g, ' ').trim()}`);
}

/** Global PageRank with a uniform teleport, following the weighted arcs of `csr`. Dangling mass is spread uniformly. */
export function globalPageRank(csr: Csr, damping = 0.85, iterations = 40): Float64Array {
  const n = csr.n;
  let rank = new Float64Array(n).fill(n === 0 ? 0 : 1 / n);
  for (let it = 0; it < iterations; it++) {
    const next = new Float64Array(n).fill(n === 0 ? 0 : (1 - damping) / n);
    let dangling = 0;
    for (let u = 0; u < n; u++) {
      const ws = csr.wsum[u]!;
      if (!(ws > 0)) {
        dangling += rank[u]!;
        continue;
      }
      const share = (damping * rank[u]!) / ws;
      for (let a = csr.offsets[u]!; a < csr.offsets[u + 1]!; a++) next[csr.targets[a]!]! += share * csr.w[a]!;
    }
    const spread = (damping * dangling) / n;
    for (let v = 0; v < n; v++) next[v]! += spread;
    rank = next;
  }
  return rank;
}

export interface SkeletonSource {
  version: string;
  nodes: ReadonlyMap<string, GraphNode>;
  /** The weighted replica, only built when the HydraDB ranking is not available. */
  csr: () => Csr;
}

export interface Skeleton {
  lines: string[];
  /** Where the ranking came from. */
  source: 'hydra' | 'local';
}

export interface SkeletonOptions {
  graphStore?: GraphStore | null;
  /** How long to wait for HydraDB before ranking locally. */
  hubsTimeoutMs?: number;
  size?: number;
}

export class SkeletonProvider {
  private readonly cache = new Map<string, Promise<Skeleton>>();
  readonly stats = { hydra: 0, local: 0, hits: 0 };

  constructor(private readonly opts: SkeletonOptions = {}) {}

  /** The skeleton for this graph version: computed once, then served from memory. */
  get(src: SkeletonSource): Promise<Skeleton> {
    const hit = this.cache.get(src.version);
    if (hit) {
      this.stats.hits++;
      return hit;
    }
    const p = this.compute(src);
    this.cache.set(src.version, p);
    // keep only the latest few versions
    while (this.cache.size > 3) this.cache.delete(this.cache.keys().next().value as string);
    return p;
  }

  private async compute(src: SkeletonSource): Promise<Skeleton> {
    const size = this.opts.size ?? SKELETON_SIZE;
    const store = this.opts.graphStore;
    if (store) {
      try {
        const ctrl = new AbortController();
        const ms = this.opts.hubsTimeoutMs ?? 500;
        const hubs = await withDeadline(store.hubs(HUB_OVERFETCH, ctrl.signal), ms, () => {
          ctrl.abort();
          return null;
        });
        if (hubs && hubs.length > 0) {
          const lines = linesFor(hubs.map((h) => h.id), src.nodes, size);
          if (lines.length > 0) {
            this.stats.hydra++;
            return { lines, source: 'hydra' };
          }
        }
      } catch {
        // fall through to the local ranking
      }
    }
    const csr = src.csr();
    const rank = globalPageRank(csr);
    const order = Array.from({ length: csr.n }, (_, i) => i).sort((a, b) => rank[b]! - rank[a]! || (csr.ids[a]! < csr.ids[b]! ? -1 : 1));
    this.stats.local++;
    return { lines: linesFor(order.map((i) => csr.ids[i]!), src.nodes, size), source: 'local' };
  }
}

function linesFor(ids: readonly string[], nodes: ReadonlyMap<string, GraphNode>, size: number): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const n = nodes.get(id);
    if (!n || !n.signature || !n.path || !SKELETON_KINDS.has(n.kind)) continue;
    out.push(`- ${n.path}: ${n.signature.replace(/\s+/g, ' ').trim()}`);
    if (out.length >= size) break;
  }
  return out;
}
