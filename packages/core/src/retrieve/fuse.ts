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
}

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
      score.set(nodeId, (score.get(nodeId) ?? 0) + weight / (cfg.rrfK + rank));
      const s = sources.get(nodeId);
      if (s) s.push(source);
      else sources.set(nodeId, [source]);
    }
  }

  const top = [...score]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, cfg.count);
  const total = top.reduce((sum, [, s]) => sum + s, 0);
  if (!(total > 0)) return [];
  return top.map(([nodeId, s]) => ({ nodeId, score: s / total, sources: sources.get(nodeId)! }));
}
