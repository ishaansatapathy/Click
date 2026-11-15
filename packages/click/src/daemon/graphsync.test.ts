import { describe, expect, it } from 'vitest';
import type { GraphStore } from '../../../core/src/store/types.js';
import type { GraphEdge, GraphNode } from '../../../core/src/types.js';
import { changeFromDelta, GraphSync, mergeChanges, type GraphChange } from './graphsync.js';

const node = (id: string): GraphNode => ({ id, kind: 'function', path: 'a.ts', name: id, tokens: 1, sigTokens: 0, fileHash: 'h' });
const edge = (from: string, to: string): GraphEdge => ({ key: `${from}|calls|${to}`, from, to, kind: 'calls' });
const change = (over: Partial<GraphChange> = {}): GraphChange => ({ version: 'v', upsertNodes: [], upsertEdges: [], deleteNodeIds: [], deleteEdgeKeys: [], ...over });

/** A GraphStore that records calls and whose upsert can be held open or made to fail. */
function stub() {
  const calls: string[] = [];
  const state = { nodes: new Set<string>(), edges: new Set<string>(), failNext: 0, gate: null as Promise<void> | null };
  const g = {
    name: 'stub',
    async upsertGraph(b: { nodes?: GraphNode[]; edges?: GraphEdge[] }, v: string) {
      calls.push(`upsert@${v}`);
      if (state.gate) await state.gate;
      if (state.failNext > 0) {
        state.failNext--;
        throw new Error('hydra down');
      }
      b.nodes?.forEach((n) => state.nodes.add(n.id));
      b.edges?.forEach((e) => state.edges.add(e.key));
    },
    async removeGraph(ids: { nodeIds?: string[]; edgeKeys?: string[] }) {
      calls.push('remove');
      ids.nodeIds?.forEach((n) => state.nodes.delete(n));
      ids.edgeKeys?.forEach((k) => state.edges.delete(k));
    },
  } as unknown as GraphStore;
  return { g, calls, state };
}

describe('mergeChanges (PROMPTS 113)', () => {
  it('the later statement about an id wins, in both directions', () => {
    const a = change({ upsertNodes: [node('x'), node('y')], deleteNodeIds: ['z'], upsertEdges: [edge('x', 'y')] });
    const b = change({ version: 'v2', deleteNodeIds: ['x'], upsertNodes: [node('z')], deleteEdgeKeys: ['x|calls|y'] });
    const m = mergeChanges(a, b);
    expect(m.version).toBe('v2');
    expect(m.upsertNodes.map((n) => n.id).sort()).toEqual(['y', 'z']);
    expect(m.deleteNodeIds).toEqual(['x']);
    expect(m.upsertEdges).toEqual([]);
    expect(m.deleteEdgeKeys).toEqual(['x|calls|y']);
  });
  it('changeFromDelta keeps nodes, edges and deletes', () => {
    const c = changeFromDelta({ fromVersion: 'a', upsertNodes: [node('n')], upsertEdges: [], upsertChunks: [], deleteNodeIds: ['d'], deleteEdgeKeys: ['k'], deleteChunkIds: ['c'] }, 'v9');
    expect(c).toEqual(change({ version: 'v9', upsertNodes: [node('n')], deleteNodeIds: ['d'], deleteEdgeKeys: ['k'] }));
  });
});

describe('GraphSync (PROMPTS 113)', () => {
  it('pushes in the background: deletes first, then upserts, then goes idle', async () => {
    const { g, calls, state } = stub();
    state.nodes.add('old');
    const s = new GraphSync(g);
    s.push(change({ upsertNodes: [node('a')], deleteNodeIds: ['old'] }));
    expect(s.busy).toBe(true);
    await s.idle();
    expect(calls).toEqual(['remove', 'upsert@v']);
    expect([...state.nodes]).toEqual(['a']);
    expect(s.busy).toBe(false);
    expect(s.stats).toEqual({ pushes: 1, failures: 0 });
  });

  it('changes that arrive while a push is in flight are coalesced into one follow-up push', async () => {
    const { g, calls } = stub();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const st = stub();
    st.state.gate = gate;
    const s = new GraphSync(st.g);
    s.push(change({ version: 'v1', upsertNodes: [node('a')] }));
    await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 20; i++) s.push(change({ version: `v${i + 2}`, upsertNodes: [node(`n${i}`)] }));
    st.state.gate = null;
    open();
    await s.idle();
    expect(st.calls).toEqual(['upsert@v1', 'upsert@v21']); // 21 changes, 2 round trips
    expect(st.state.nodes.size).toBe(21);
    void g;
    void calls;
  });

  it('a failed push is retried with backoff, keeps its changes, and merges with newer ones; push() never throws', async () => {
    const { g, state, calls } = stub();
    state.failNext = 2;
    const s = new GraphSync(g, { retryMs: [10, 10] });
    expect(() => s.push(change({ upsertNodes: [node('a')] }))).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    s.push(change({ version: 'v2', upsertNodes: [node('b')] })); // arrives while waiting to retry
    await s.idle();
    expect([...state.nodes].sort()).toEqual(['a', 'b']);
    expect(s.stats.failures).toBe(2);
    expect(s.stats.pushes).toBe(1);
    expect(calls.filter((c) => c.startsWith('upsert')).length).toBe(3);
  });

  it('ignores empty changes and stops after close', async () => {
    const { g, calls } = stub();
    const s = new GraphSync(g);
    s.push(change());
    expect(s.busy).toBe(false);
    s.close();
    s.push(change({ upsertNodes: [node('a')] }));
    await s.idle();
    expect(calls).toEqual([]);
  });

  it('close() releases anyone waiting on idle()', async () => {
    const st = stub();
    st.state.failNext = 99;
    const s = new GraphSync(st.g, { retryMs: [60_000] });
    s.push(change({ upsertNodes: [node('a')] }));
    const waiting = s.idle();
    await new Promise((r) => setTimeout(r, 20));
    s.close();
    await waiting;
  });
});
