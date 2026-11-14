// FROZEN CONTRACT (PLAN §14.4). Changes only through a contract change (PLAN §14.8).
// Source of truth: SPEC §4 (Store) and §4.2 (Embedder).
// Lane A implements these (memory.ts, hydradb.ts, embed.ts); Lane B consumes them (pipeline, daemon).

import type { ChunkRecord, Convention, GraphEdge, GraphNode, NodeKind, WeightsDoc } from '../types.js';

export interface UpsertBatch {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  chunks?: ChunkRecord[];
}

export interface RemoveIds {
  nodeIds?: string[];
  edgeKeys?: string[];
  chunkIds?: string[];
}

export interface HybridQuery {
  text: string;
  vector?: number[];
  k: number;
  /** When set, search nodes of these kinds instead of chunks. */
  kinds?: NodeKind[];
}

export interface ScoredId {
  id: string;
  score: number;
}

export interface Store {
  readonly name: string; // 'memory' | 'hydradb' | 'fake'
  /** Idempotent: the same id always overwrites. */
  upsert(batch: UpsertBatch, indexVersion: string): Promise<void>;
  remove(ids: RemoveIds): Promise<void>;
  /** Ids of chunks (or of nodes, when `kinds` is set), best first. Must honour `signal`. */
  hybridQuery(q: HybridQuery, signal?: AbortSignal): Promise<ScoredId[]>;
  /** Everything in the store, in pages. Used by `click pull` to rebuild the local snapshot. */
  loadAll(): AsyncIterable<UpsertBatch>;
  getWeights(): Promise<WeightsDoc | null>;
  putWeights(doc: WeightsDoc): Promise<void>;
  getConventions(): Promise<Convention[]>;
  putConventions(items: Convention[]): Promise<void>;
}

export interface Embedder {
  readonly model: string; // e.g. 'voyage-code-3', 'hydra-server', 'fake'
  readonly dims: number;
  embed(texts: string[], inputType: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array[]>;
}
