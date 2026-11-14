// FROZEN after Phase 0 (PLAN §5). Changes need Ishaan's approval. Source of truth: SPEC.md §2.

export type NodeKind =
  | 'file' | 'component' | 'composable' | 'store' | 'route'
  | 'function' | 'type' | 'test' | 'chunk' | 'convention';

export interface LineRange { startLine: number; endLine: number } // 1-based, inclusive

export interface GraphNode {
  id: string;                 // SPEC §2.1
  kind: NodeKind;
  path: string | null;        // posix, repo-relative; null for conventions and routes without a file
  name: string;
  range?: LineRange;
  signature?: string;         // ≤ 300 chars, body replaced by "{ … }"
  doc?: string;               // first JSDoc line
  tokens: number;             // body tokens (proxy tokenizer, SPEC §9.4)
  sigTokens: number;
  fileHash: string;           // hash of the containing file at index time
  meta?: Record<string, unknown>; // props, emits, slots, exposed, stateKeys, getters, actions, routeName, returns…
}

export type EdgeKind =
  | 'contains' | 'imports' | 'uses_component' | 'passes_prop' | 'emits_to' | 'calls'
  | 'uses_store' | 'uses_composable' | 'routes_to' | 'has_type' | 'tested_by' | 'co_changed';

export interface GraphEdge {
  key: string;                // `${from}|${kind}|${to}`
  from: string;
  to: string;
  kind: EdgeKind;
  meta?: { props?: string[]; events?: string[]; source?: 'ast' | 'git' | 'learned'; support?: number };
}

export interface ChunkRecord {
  id: string;                 // chunk:<path>#<symbol|_template|_file>#<n>
  nodeId: string;             // parent symbol or file node
  path: string;
  range: LineRange;
  text: string;               // stored in HydraDB for search; locally bodies are read from disk
  vector?: number[];
}

export interface Graph {
  version: string;
  repoCommit: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  chunks: Omit<ChunkRecord, 'text' | 'vector'>[];
}

export interface GraphDelta {
  fromVersion: string;
  upsertNodes: GraphNode[];
  upsertEdges: GraphEdge[];
  upsertChunks: ChunkRecord[];
  deleteNodeIds: string[];
  deleteEdgeKeys: string[];
  deleteChunkIds: string[];
}

export interface Task {
  id?: string;
  text: string;
  budgetTokens: number;
  sessionId?: string;
  openFiles?: string[];
}

export type SeedSource = 'symbol' | 'bm25' | 'semantic' | 'open-file';
export interface Seed { nodeId: string; score: number; sources: SeedSource[] }

export interface Candidate {
  nodeId: string;
  score: number;              // final score used for packing order
  pprScore: number;
  via: string[];              // edge keys, seed → node (attribution path)
  reasons: string[];          // human-readable: "seed: symbol match", "via uses_store from CheckoutButton"
  keepProb?: number;          // set by pruner
}

export type PackMode = 'body' | 'signature' | 'ref' | 'file';
export interface PackedItem { nodeId: string; path: string | null; name: string; mode: PackMode; tokens: number; range?: LineRange }

export interface PackedContext {
  contextId: string;
  text: string;
  tokens: number;
  budget: number;
  items: PackedItem[];
  seeds: Seed[];
  variant: string;
  configHash: string;
  pruner: string;             // 'none' | 'rerank' | 'jev' | 'fallback:<from>-><to>'
  graphVersion: string;
  weightsVersion: string | null;
  timings: Record<string, number>; // ms per stage + total
  degraded: string[];         // 'warming' | 'semantic-timeout' | 'semantic-error' | 'prune-timeout' | 'stale-body' | …
}

export interface Convention { id: string; text: string; source: string; validFrom: string; validTo: string | null }

export interface WeightsDoc {
  v: 1;
  version: string;            // hash of params + multipliers + addedEdges
  derivedFrom: string | null; // id of the last event included
  events: number;
  params: LearnParams;
  multipliers: Record<string, number>; // edgeKey → multiplier
  addedEdges: GraphEdge[];    // learned co_changed edges
}

export interface LearnParams { alpha: number; beta: number; min: number; max: number }
