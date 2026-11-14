import { describe, expect, it } from 'vitest';
import type {
  Candidate, ChunkRecord, Convention, Graph, GraphDelta, GraphEdge, GraphNode,
  PackedContext, Seed, Task, WeightsDoc,
} from '../src/types.js';

// Compile-time check: each literal below must satisfy its SPEC §2 type exactly.
const node: GraphNode = {
  id: 'sym:src/stores/order.ts#useOrderStore', kind: 'store', path: 'src/stores/order.ts',
  name: 'useOrderStore', range: { startLine: 1, endLine: 40 }, tokens: 120, sigTokens: 18, fileHash: 'abc123',
};
const edge: GraphEdge = {
  key: 'sym:a#A|uses_store|sym:b#useB', from: 'sym:a#A', to: 'sym:b#useB', kind: 'uses_store', meta: { source: 'ast' },
};
const chunk: ChunkRecord = {
  id: 'chunk:src/a.ts#A#0', nodeId: 'sym:src/a.ts#A', path: 'src/a.ts',
  range: { startLine: 1, endLine: 10 }, text: 'export const A = 1;',
};
const graph: Graph = { version: 'v1', repoCommit: null, nodes: [node], edges: [edge], chunks: [] };
const delta: GraphDelta = {
  fromVersion: 'v1', upsertNodes: [], upsertEdges: [], upsertChunks: [chunk],
  deleteNodeIds: [], deleteEdgeKeys: [], deleteChunkIds: [],
};
const task: Task = { text: 'add loading state', budgetTokens: 4000 };
const seed: Seed = { nodeId: node.id, score: 0.5, sources: ['symbol', 'bm25'] };
const cand: Candidate = { nodeId: node.id, score: 0.4, pprScore: 0.4, via: [], reasons: ['seed: symbol match'] };
const conv: Convention = { id: 'conv:script-setup', text: 'Use <script setup>', source: 'CLAUDE.md', validFrom: '2026-11-15', validTo: null };
const weights: WeightsDoc = {
  v: 1, version: 'w1', derivedFrom: null, events: 0,
  params: { alpha: 0.2, beta: 0.1, min: 0.1, max: 5 }, multipliers: {}, addedEdges: [],
};
const packed: PackedContext = {
  contextId: 'ctx1', text: '', tokens: 0, budget: 4000,
  items: [{ nodeId: node.id, path: node.path, name: node.name, mode: 'body', tokens: 120 }],
  seeds: [seed], variant: 'V3', configHash: 'h', pruner: 'none', graphVersion: 'v1', weightsVersion: null,
  timings: { total: 1 }, degraded: [],
};

describe('core types', () => {
  it('accepts well-formed values of every SPEC §2 type', () => {
    expect([graph, delta, task, cand, conv, weights, packed].every(Boolean)).toBe(true);
    expect(packed.items[0]?.nodeId).toBe(graph.nodes[0]?.id);
  });
});
