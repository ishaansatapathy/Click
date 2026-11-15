// FROZEN CONTRACT (PLAN §14.4). Changes only through a contract change (PLAN §14.8).
// Source of truth: SPEC §4 (Store), §4.2 (Embedder), §4.3 (GraphStore).
// Lane A implements these (memory.ts, hydradb.ts, embed.ts); Lane B consumes them (pipeline, daemon).
//
// contract/1 (2026-11-15): GraphStore added. The self-hosted open-source HydraDB is the code graph's system of record
// and traversal engine (GraphStore). `Store` keeps chunks, the semantic index, weights doc and conventions
// (MemoryStore implements it locally). See docs/hydradb-oss-notes.md for the verified engine capabilities.

import type { ChunkRecord, Convention, EdgeKind, GraphEdge, GraphNode, NodeKind, WeightsDoc } from '../types.js';

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
  readonly model: string; // e.g. 'text-embedding-3-small', 'fake'
  readonly dims: number;
  embed(texts: string[], inputType: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array[]>;
}

// ---------------------------------------------------------------- GraphStore (SPEC §4.3), contract/1

/** One typed edge as stored, with its learned multiplier (`null` when never learned: treat as 1.0). */
export interface EdgeRow {
  from: string; // our string node ids, never HydraDB vertex ids
  to: string;
  kind: EdgeKind;
  w: number | null;
}

export interface NeighbourhoodOptions {
  hops: 1 | 2;
  /** Edge kinds to follow; default: all. */
  kinds?: EdgeKind[];
  /** Cap on the frontier carried into hop 2 (highest-degree-first is not required; first-seen is fine). */
  maxFrontier?: number;
  /** Cap on edges returned. */
  maxEdges?: number;
}

export interface ImpactOptions {
  maxHops: number;
  /** Edge kinds whose *incoming* direction means "depends on me"; default: every usage/structural kind. */
  kinds?: EdgeKind[];
  limit?: number;
}

export interface GraphStore {
  readonly name: string; // 'hydradb' | 'memory' | 'fake'
  health(signal?: AbortSignal): Promise<{ ok: boolean; version?: string; detail?: string }>;
  /** Idempotent. Nodes before edges (edges never create unlabelled endpoints). */
  upsertGraph(batch: { nodes?: GraphNode[]; edges?: GraphEdge[] }, indexVersion: string): Promise<void>;
  removeGraph(ids: { nodeIds?: string[]; edgeKeys?: string[] }): Promise<void>;
  /**
   * Typed edges touching `ids` (both directions), and with hops = 2 the edges touching their neighbours.
   * One logical network call on the hot path; must honour `signal`.
   */
  neighbourhood(ids: string[], opts: NeighbourhoodOptions, signal?: AbortSignal): Promise<EdgeRow[]>;
  /** Dependents of `id` via incoming edges, as node-id paths from the dependent to `id`, nearest first. */
  impact(id: string, opts: ImpactOptions, signal?: AbortSignal): Promise<{ path: string[]; kinds: EdgeKind[] }[]>;
  /** Global hub ranking (PageRank in HydraDB), best first. */
  hubs(k: number, signal?: AbortSignal): Promise<{ id: string; score: number }[]>;
  /** Write learned multipliers onto existing edges (learn lane, never the hot path). */
  setEdgeWeights(updates: { key: string; w: number }[]): Promise<void>;
  /** Everything, in pages: rebuilds the local replica used as the offline fallback. */
  loadAll(): AsyncIterable<{ nodes?: GraphNode[]; edges?: GraphEdge[] }>;
}
