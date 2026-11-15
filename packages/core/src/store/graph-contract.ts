import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GraphEdge, GraphNode } from '../types.js';
import { netCounter } from '../util/http.js';
import { edgeKey } from '../util/ids.js';
import type { GraphStore } from './types.js';

export interface GraphStoreContractOptions {
  live?: boolean;
  /** Give an eventually-consistent indexer time to observe the just-written graph. */
  settle?: () => Promise<void>;
}

/** Reusable observable GraphStore contract. Pass `live: true` to gate the suite on CLICK_LIVE=1. */
export function runGraphStoreContract(
  name: string,
  make: () => GraphStore | Promise<GraphStore>,
  options: GraphStoreContractOptions = {},
): void {
  const suite = options.live && process.env.CLICK_LIVE !== '1' ? describe.skip : describe;
  const prefix = `contract:${process.pid}:${Date.now()}:${name}:`;
  const ids = { target: `${prefix}target`, first: `${prefix}first`, second: `${prefix}second` };
  const nodes = Object.entries(ids).map(([name_, id], index): GraphNode => ({
    id, kind: 'function', path: `contract/${name_}.ts`, name: name_,
    range: { startLine: index + 1, endLine: index + 2 }, signature: `function ${name_}()`,
    ...(index === 0 ? { doc: 'contract doc', meta: { contract: true } } : {}),
    tokens: index + 2, sigTokens: 2, fileHash: `hash-${index}`,
  }));
  const edges: GraphEdge[] = [
    { key: edgeKey(ids.first, 'calls', ids.target), from: ids.first, to: ids.target, kind: 'calls', meta: { source: 'ast' } },
    { key: edgeKey(ids.second, 'imports', ids.first), from: ids.second, to: ids.first, kind: 'imports' },
  ];
  let store: GraphStore;

  suite(`GraphStore contract: ${name}`, () => {
    beforeEach(async () => {
      store = await make();
      await store.removeGraph({ nodeIds: Object.values(ids) });
      await store.upsertGraph({ nodes, edges }, 'contract-v1');
      await options.settle?.();
    });

    afterEach(async () => {
      await store.removeGraph({ nodeIds: Object.values(ids) });
    });

    it('is healthy and round-trips the complete topology', async () => {
      await expect(store.health()).resolves.toMatchObject({ ok: true });
      const loadedNodes: GraphNode[] = [];
      const loadedEdges: GraphEdge[] = [];
      for await (const page of store.loadAll()) {
        loadedNodes.push(...(page.nodes ?? []));
        loadedEdges.push(...(page.edges ?? []));
      }
      expect(loadedNodes.filter((node) => Object.values(ids).includes(node.id))).toEqual(expect.arrayContaining(nodes));
      expect(loadedEdges.filter((edge) => edges.some((wanted) => wanted.key === edge.key))).toEqual(expect.arrayContaining(edges));
    });

    it('reads a weighted two-hop neighbourhood as one logical call', async () => {
      await store.setEdgeWeights([{ key: edges[0]!.key, w: 1.75 }]);
      const counted = await netCounter.run(() => store.neighbourhood([ids.target], { hops: 2 }));
      expect(counted.calls).toBe(1);
      expect(counted.result).toEqual(expect.arrayContaining([
        { from: ids.first, to: ids.target, kind: 'calls', w: 1.75 },
        { from: ids.second, to: ids.first, kind: 'imports', w: null },
      ]));
    });

    it('returns incoming impact paths nearest first', async () => {
      const result = await store.impact(ids.target, { maxHops: 2, kinds: ['calls', 'imports'] });
      expect(result).toEqual(expect.arrayContaining([
        { path: [ids.first, ids.target], kinds: ['calls'] },
        { path: [ids.second, ids.first, ids.target], kinds: ['imports', 'calls'] },
      ]));
    });

    it('ranks hubs and removes edges and nodes idempotently', async () => {
      // The live namespace may also contain the bench graph; ask for enough rows to include this suite's isolated nodes.
      const hubs = await store.hubs(1_000);
      if (!options.live) expect(hubs.some((item) => item.id === ids.target)).toBe(true);
      else expect(hubs.length).toBeGreaterThan(0);
      expect(hubs.every((item, index) => index === 0 || hubs[index - 1]!.score >= item.score)).toBe(true);
      await store.removeGraph({ edgeKeys: [edges[0]!.key], nodeIds: [ids.second] });
      await store.removeGraph({ edgeKeys: [edges[0]!.key], nodeIds: [ids.second] });
      await expect(store.neighbourhood([ids.target], { hops: 2 })).resolves.toEqual([]);
    });
  });
}
