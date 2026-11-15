import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { GraphEdge, GraphNode } from '../types.js';
import { HydraDbGraphStore, HydraHttpClient, HydraQueryError, decodeCell, vid } from './hydradb-graph.js';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

const node = (id: string, name = id): GraphNode => ({
  id, kind: 'function', path: 'src/a.ts', name, range: { startLine: 1, endLine: 2 },
  signature: `function ${name}()`, tokens: 3, sigTokens: 2, fileHash: 'hash',
});

const edge = (from: string, to: string, kind: GraphEdge['kind'] = 'calls'): GraphEdge => ({
  key: `${from}|${kind}|${to}`, from, to, kind,
});

describe('HydraHttpClient', () => {
  it('decodes typed rows and follows consuming cursors with the full original request', async () => {
    const requests: Record<string, unknown>[] = [];
    const responses = [
      { columns: ['key'], rows: [[{ type: 'string', value: 'a' }]], query_id: 'q1', next_cursor: 8 },
      { columns: ['key'], rows: [[{ type: 'string', value: 'b' }]], query_id: 'q1', next_cursor: null },
    ];
    const client = new HydraHttpClient({ token: 'secret', fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json(responses.shift());
    } });

    await expect(client.query('MATCH (n) RETURN n.key AS key', { x: 1 }, { pageSize: 64 }))
      .resolves.toEqual([{ key: 'a' }, { key: 'b' }]);
    expect(requests[1]).toMatchObject({
      cell_id: 'cell-0', query: 'MATCH (n) RETURN n.key AS key', parameters: { x: 1 },
      page_size: 64, cursor: 8, query_id: 'q1',
    });
  });

  it('surfaces server messages and rejects malformed success envelopes', async () => {
    const errorClient = new HydraHttpClient({ token: 'secret', fetch: async () => json({ error: { code: 'invalid_request', message: 'bad Cypher' } }) });
    await expect(errorClient.query('bad')).rejects.toMatchObject({ name: 'HydraQueryError', message: 'bad Cypher', code: 'invalid_request' });
    const malformed = new HydraHttpClient({ token: 'secret', fetch: async () => json({ success: true }) });
    await expect(malformed.query('MATCH')).rejects.toThrow('did not contain rows');
    const statusError = new HydraHttpClient({ token: 'secret', fetch: async () => json({ error: { message: 'wrong token' } }, 401) });
    await expect(statusError.query('MATCH')).rejects.toThrow('wrong token');
  });

  it('decodes null and validates typed cells', () => {
    expect(decodeCell({ type: 'null', value: 'ignored' })).toBeNull();
    expect(decodeCell({ type: 'vertex_id', value: 42 })).toBe(42);
    expect(() => decodeCell({ type: '', value: 1 })).not.toThrow();
    expect(() => decodeCell(null as never)).toThrow(HydraQueryError);
  });
});

describe('HydraDbGraphStore write side', () => {
  it('uses stable JS-safe 48-bit ids and writes nodes before per-type edges', async () => {
    const bodies: { query: string; parameters: { rows?: unknown[] } }[] = [];
    const store = new HydraDbGraphStore({ token: 'secret', fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number]);
      return json({ columns: [], rows: [], next_cursor: null });
    } });
    const a = node('sym:src/a.ts#a', 'a');
    const b = node('sym:src/b.ts#b', 'b');
    await store.upsertGraph({ nodes: [a, b], edges: [edge(a.id, b.id, 'calls'), edge(b.id, a.id, 'imports')] }, 'v1');

    expect(vid(a.id)).toBeLessThan(2 ** 48);
    expect(Number.isSafeInteger(vid(a.id))).toBe(true);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]!.query).toContain('SET n:CodeNode');
    expect(bodies[1]!.query).toContain('[:IMPORTS]');
    expect(bodies[2]!.query).toContain('[:CALLS]');
    expect(bodies[0]!.parameters.rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: vid(a.id), key: a.id })]));
  });

  it('deletes explicit edges before batched DETACH DELETE nodes', async () => {
    const queries: string[] = [];
    const store = new HydraDbGraphStore({ token: 'secret', fetch: async (_url, init) => {
      queries.push((JSON.parse(String(init?.body)) as { query: string }).query);
      return json({ columns: [], rows: [], next_cursor: null });
    } });
    await store.removeGraph({ nodeIds: ['file:src/a.ts'], edgeKeys: ['file:src/a.ts|imports|file:src/b.ts'] });
    expect(queries[0]).toContain('[r:IMPORTS]');
    expect(queries[1]).toContain('DETACH DELETE');
  });
});

const live = process.env.CLICK_LIVE === '1' ? describe : describe.skip;
live('HydraDbGraphStore live write side', () => {
  it('round-trips nodes and an edge against self-hosted HydraDB', async () => {
    const tokenFile = process.env.HYDRADB_TOKEN_FILE ?? resolve('.click', 'hydradb-token');
    const token = (await readFile(tokenFile, 'utf8')).trim();
    const store = new HydraDbGraphStore({ token });
    const suffix = `${process.pid}-${Date.now()}`;
    const a = node(`sym:live/${suffix}.ts#a`, 'liveA');
    const b = node(`sym:live/${suffix}.ts#b`, 'liveB');
    const e = edge(a.id, b.id);
    try {
      await store.upsertGraph({ nodes: [a, b], edges: [e] }, 'live-v1');
      const rows = await store.client.query('MATCH (a:CodeNode {id: $src})-[:CALLS]->(b) RETURN a.key AS src, b.key AS dst', { src: vid(a.id) });
      expect(rows).toEqual([{ src: a.id, dst: b.id }]);
    } finally {
      await store.removeGraph({ nodeIds: [a.id, b.id] });
    }
  });
});
