// PROMPTS 087: weighted reciprocal rank fusion of the seed lists (symbol, bm25, semantic).
//   score(node) = Σ over sources  weight[source] / (rrfK + rank_in_source)      (rank is 1-based)
// Semantic hits are chunk ids: they are mapped to their parent node before fusion, and several chunks of one node
// count once, at the best rank. The top `count` nodes become the seeds; their scores are normalised to sum to 1 so
// they can be used directly as the PPR restart distribution. Ties break by node id, so the output is deterministic.

import type { ScoredId } from '../store/types.js';
import type { Graph, Seed, SeedSource } from '../types.js';

export interface FuseConfig {
  sources: readonly SeedSource[];
  weights: Record<'symbol' | 'bm25' | 'semantic', number>;
  count: number;
  rrfK: number;
  /** Seed slots kept for the best semantic hits when semantic runs next to another source (default 5, 0 turns it off). */
  semanticReserve?: number;
}

/** The semantic reservation: a node the embeddings put near the top must reach the graph even if weighted RRF would crowd it out. */
export const SEMANTIC_RESERVE = 5;

export type SeedLists = Partial<Record<'symbol' | 'bm25' | 'semantic', readonly ScoredId[]>>;

/** Chunk id → parent node id. Ids that are not chunks pass through, so symbol and bm25 lists can use it too. */
export function chunkResolver(graph: Pick<Graph, 'chunks'>): (id: string) => string {
  const parent = new Map(graph.chunks.map((c) => [c.id, c.nodeId]));
  return (id) => parent.get(id) ?? id;
}

export function fuseSeeds(lists: SeedLists, cfg: FuseConfig, resolve: (id: string) => string = (id) => id): Seed[] {
  if (cfg.count < 1) return [];
  const score = new Map<string, number>();
  const sources = new Map<string, SeedSource[]>();
  const semanticOrder: string[] = []; // unique resolved nodes, best semantic hit first

  for (const source of ['symbol', 'bm25', 'semantic'] as const) {
    const list = lists[source];
    const weight = cfg.weights[source];
    if (!list?.length || !cfg.sources.includes(source) || !(weight > 0)) continue;

    // rank by score (stable, ties by id), map to nodes, keep each node's best position
    const ranked = [...list].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const seen = new Set<string>();
    let rank = 0;
    for (const hit of ranked) {
      const nodeId = resolve(hit.id);
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      rank++;
      if (source === 'semantic') semanticOrder.push(nodeId);
      score.set(nodeId, (score.get(nodeId) ?? 0) + weight / (cfg.rrfK + rank));
      const s = sources.get(nodeId);
      if (s) s.push(source);
      else sources.set(nodeId, [source]);
    }
  }

  const byScore = (a: [string, number], b: [string, number]): number => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const ordered = [...score].sort(byScore);

  // Hybrid fusion (semantic next to at least one other source): the first few semantic nodes keep their seed slots, the rest of the
  // slots go to the weighted-RRF order. Semantic-only and semantic-off configurations are untouched.
  const others = (['symbol', 'bm25'] as const).some((o) => cfg.sources.includes(o) && cfg.weights[o] > 0);
  const hybrid = cfg.sources.includes('semantic') && cfg.weights.semantic > 0 && others;
  const reserved = hybrid ? semanticOrder.slice(0, Math.min(cfg.semanticReserve ?? SEMANTIC_RESERVE, cfg.count)) : [];
  let top: [string, number][];
  if (reserved.length === 0) top = ordered.slice(0, cfg.count);
  else {
    const keep = new Set(reserved);
    const fill = ordered.filter(([id]) => !keep.has(id)).slice(0, cfg.count - reserved.length);
    top = [...reserved.map((id): [string, number] => [id, score.get(id)!]), ...fill].sort(byScore);
  }
  const total = top.reduce((sum, [, s]) => sum + s, 0);
  if (!(total > 0)) return [];
  return top.map(([nodeId, s]) => ({ nodeId, score: s / total, sources: sources.get(nodeId)! }));
}
