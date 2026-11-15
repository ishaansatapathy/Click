import { beforeEach, describe, expect, it } from 'vitest';

import type { ChunkRecord, Convention, GraphEdge, GraphNode, WeightsDoc } from '../types.js';
import type { Store, UpsertBatch } from './types.js';

export type StoreFactory = () => Store | Promise<Store>;

const node = (name: string): GraphNode => ({
  id: 'sym:src/order.ts#submitOrder',
  kind: 'function',
  path: 'src/order.ts',
  name,
  signature: `export function ${name}()`,
  tokens: 12,
  sigTokens: 4,
  fileHash: 'contract-file-hash',
});

const edge: GraphEdge = {
  key: 'sym:src/order.ts#submitOrder|calls|sym:src/cart.ts#clearCart',
  from: 'sym:src/order.ts#submitOrder',
  to: 'sym:src/cart.ts#clearCart',
  kind: 'calls',
};

const chunk: ChunkRecord = {
  id: 'chunk:src/order.ts#submitOrder#0',
  nodeId: 'sym:src/order.ts#submitOrder',
  path: 'src/order.ts',
  range: { startLine: 1, endLine: 4 },
  text: 'Submit the order and clear the shopping cart after payment succeeds.',
  vector: [1, 0, 0],
};

const weights: WeightsDoc = {
  v: 1,
  version: 'contract-weights-v1',
  derivedFrom: null,
  events: 3,
  params: { alpha: 0.2, beta: 0.1, min: 0.25, max: 4 },
  multipliers: { [edge.key]: 1.25 },
  addedEdges: [edge],
};

const conventions: Convention[] = [{
  id: 'conv:contract',
  text: 'Use named exports.',
  source: 'AGENTS.md',
  validFrom: '2026-11-15T00:00:00.000Z',
  validTo: null,
}];

async function allRecords(store: Store): Promise<Required<UpsertBatch>> {
  const records: Required<UpsertBatch> = { nodes: [], edges: [], chunks: [] };
  for await (const page of store.loadAll()) {
    records.nodes.push(...(page.nodes ?? []));
    records.edges.push(...(page.edges ?? []));
    records.chunks.push(...(page.chunks ?? []));
  }
  return records;
}

/** Registers the reusable SPEC section 4 contract against a Store factory. */
export function runStoreContract(makeStore: StoreFactory, label = 'Store'): void {
  describe(`${label} contract`, () => {
    let store: Store;

    beforeEach(async () => {
      store = await makeStore();
    });

    it('upserts idempotently and overwrites the record with the same ID', async () => {
      await store.upsert({ nodes: [node('submitOrder')] }, 'index-v1');
      await store.upsert({ nodes: [node('placeOrder')] }, 'index-v2');

      const records = await allRecords(store);
      expect(records.nodes).toHaveLength(1);
      expect(records.nodes[0]).toMatchObject({ id: node('').id, name: 'placeOrder' });
    });

    it('removes nodes, edges, and chunks by their respective IDs', async () => {
      await store.upsert({ nodes: [node('submitOrder')], edges: [edge], chunks: [chunk] }, 'index-v1');
      await store.remove({ nodeIds: [node('').id], edgeKeys: [edge.key], chunkIds: [chunk.id] });

      expect(await allRecords(store)).toEqual({ nodes: [], edges: [], chunks: [] });
    });

    it('hybridQuery returns a stored chunk for its own text', async () => {
      await store.upsert({ chunks: [chunk] }, 'index-v1');

      const hits = await store.hybridQuery({ text: chunk.text, k: 5 });
      expect(hits.map((hit) => hit.id)).toContain(chunk.id);
      expect(hits.every((hit) => Number.isFinite(hit.score))).toBe(true);
    });

    it('loadAll returns every stored record exactly once across all pages', async () => {
      await store.upsert({ nodes: [node('submitOrder')], edges: [edge], chunks: [chunk] }, 'index-v1');

      const records = await allRecords(store);
      expect(records.nodes.map(({ id }) => id)).toEqual([node('').id]);
      expect(records.edges.map(({ key }) => key)).toEqual([edge.key]);
      expect(records.chunks.map(({ id }) => id)).toEqual([chunk.id]);
    });

    it('round-trips weights and conventions', async () => {
      expect(await store.getWeights()).toBeNull();
      expect(await store.getConventions()).toEqual([]);

      await store.putWeights(weights);
      await store.putConventions(conventions);

      expect(await store.getWeights()).toEqual(weights);
      expect(await store.getConventions()).toEqual(conventions);
    });
  });
}
