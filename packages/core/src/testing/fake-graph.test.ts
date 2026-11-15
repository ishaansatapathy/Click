import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from '../types.js';
import { edgeKey } from '../util/ids.js';
import { netCounter } from '../util/http.js';
import { FakeGraphStore } from './fakes.js';

const node = (id: string): GraphNode => ({ id, kind: 'function', path: 'src/a.ts', name: id, tokens: 1, sigTokens: 1, fileHash: 'h' });
const edge = (from: string, kind: GraphEdge['kind'], to: string): GraphEdge => ({ key: edgeKey(from, kind, to), from, to, kind });

// view → store ← composable ← component ; route → view ; component → util
async function graph(): Promise<FakeGraphStore> {
  const g = new FakeGraphStore();
  await g.upsertGraph(
    {
      nodes: ['route', 'view', 'store', 'composable', 'component', 'util'].map(node),
      edges: [
        edge('route', 'routes_to', 'view'),
        edge('view', 'uses_store', 'store'),
        edge('composable', 'uses_store', 'store'),
        edge('component', 'uses_composable', 'composable'),
        edge('component', 'calls', 'util'),
      ],
    },
    'v1',
  );
  return g;
}

describe('FakeGraphStore (GraphStore contract/1)', () => {
  it('neighbourhood: both directions, 1 and 2 hops, kind filter, one network call', async () => {
    const g = await graph();
    const { result: one, calls } = await netCounter.run(() => g.neighbourhood(['store'], { hops: 1 }));
    expect(calls).toBe(1);
    expect(one.map((e) => `${e.from}>${e.to}`).sort()).toEqual(['composable>store', 'view>store']);
    const two = await g.neighbourhood(['store'], { hops: 2 });
    expect(two.map((e) => `${e.from}>${e.to}`).sort()).toEqual(['component>composable', 'composable>store', 'route>view', 'view>store']);
    const onlyStore = await g.neighbourhood(['store'], { hops: 2, kinds: ['uses_store'] });
    expect(onlyStore).toHaveLength(2);
    expect(await g.neighbourhood(['store'], { hops: 2, maxEdges: 1 })).toHaveLength(1);
  });

  it('weights are null until learned, then read back on every edge row', async () => {
    const g = await graph();
    expect((await g.neighbourhood(['view'], { hops: 1 })).every((e) => e.w === null)).toBe(true);
    await g.setEdgeWeights([{ key: edgeKey('view', 'uses_store', 'store'), w: 1.44 }, { key: 'missing|calls|x', w: 9 }]);
    const rows = await g.neighbourhood(['view'], { hops: 1 });
    expect(rows.find((e) => e.to === 'store')?.w).toBe(1.44);
    // re-upserting the structure keeps learned weights
    await g.upsertGraph({ edges: [edge('view', 'uses_store', 'store')] }, 'v2');
    expect((await g.neighbourhood(['view'], { hops: 1 })).find((e) => e.to === 'store')?.w).toBe(1.44);
  });

  it('impact: dependents through incoming edges, nearest first, with paths and kinds', async () => {
    const g = await graph();
    const paths = await g.impact('store', { maxHops: 2 });
    expect(paths.map((p) => p.path.join('>'))).toEqual(['view>store', 'composable>store', 'route>view>store', 'component>composable>store']);
    expect(paths[3]?.kinds).toEqual(['uses_composable', 'uses_store']);
    expect(await g.impact('store', { maxHops: 1 })).toHaveLength(2);
  });

  it('hubs: PageRank puts the most depended-on node first', async () => {
    const g = await graph();
    expect((await g.hubs(1))[0]?.id).toBe('store');
  });

  it('removeGraph drops nodes with their edges', async () => {
    const g = await graph();
    await g.removeGraph({ nodeIds: ['store'] });
    expect(await g.neighbourhood(['view'], { hops: 1 })).toHaveLength(1); // only route→view remains
  });

  it('can be slow or fail, honouring abort', async () => {
    const slow = new FakeGraphStore({ latencyMs: 2000 });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error('deadline')), 20);
    await expect(slow.neighbourhood(['x'], { hops: 1 }, ctrl.signal)).rejects.toThrow('deadline');
    await expect(new FakeGraphStore({ failWith: new Error('hydradb down') }).neighbourhood(['x'], { hops: 1 })).rejects.toThrow('hydradb down');
  });
});
