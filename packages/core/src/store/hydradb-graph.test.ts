import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { GraphEdge, GraphNode } from '../types.js';
import { netCounter } from '../util/http.js';
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
    expect(bodies).toHaveLength(4);
    expect(bodies[0]!.query).toContain('SET n:CodeNode');
    expect(bodies[1]!.query).toContain('[:IMPORTS]');
    expect(bodies[2]!.query).toContain('[:CALLS]');
    expect(bodies[3]!.query).toContain('n.indexVersion = row.version');
    expect(bodies[0]!.parameters.rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: vid(a.id), key: a.id })]));
  });

  it('reads the persisted graph version metadata', async () => {
    const store = new HydraDbGraphStore({ token: 'secret', fetch: async () => json({
      columns: ['version'], rows: [[{ type: 'string', value: 'v123' }]], next_cursor: null,
    }) });
    await expect(store.getIndexVersion()).resolves.toBe('v123');
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

describe('HydraDbGraphStore read side', () => {
  it('uses one MSpaths traversal, decodes directed weights, and counts one logical call', async () => {
    const queries: string[] = [];
    const store = new HydraDbGraphStore({ token: 'secret', fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      queries.push(request.query);
      if (request.query.includes('RETURN n.key AS key')) return json({
        columns: ['key'], rows: ['target', 'dep', 'second'].map((key) => [{ type: 'string', value: key }]), next_cursor: null,
      });
      const vertex = (id: number, key: string) => ({ id, properties: { key: { String: key } } });
      const first = { edge_type: 'CALLS', src: 2, dst: 1, properties: { w: { Float: 1.5 } } };
      return json({ columns: ['path'], rows: [
        [{ type: 'path', value: { nodes: [vertex(1, 'target'), vertex(2, 'dep')], relationships: [first] } }],
        [{ type: 'path', value: { nodes: [vertex(1, 'target'), vertex(2, 'dep'), vertex(3, 'second')], relationships: [first, { edge_type: 'CALLS', src: 3, dst: 2, properties: {} }] } }],
      ], next_cursor: null });
    } });
    const counted = await netCounter.run(() => store.neighbourhood(['target'], { hops: 2, kinds: ['calls'] }));
    expect(counted.calls).toBe(1);
    expect(counted.attempts).toBe(2);
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain('CALL algo.MSpaths');
    expect(queries[1]).toContain('pathCount: 1');
    expect(counted.result).toEqual([
      { from: 'dep', to: 'target', kind: 'calls', w: 1.5 },
      { from: 'second', to: 'dep', kind: 'calls', w: null },
    ]);
  });

  it('decodes OSS path payloads into dependent-to-target ids and kinds', async () => {
    const path = {
      nodes: [
        { properties: { key: { String: 'target' } } },
        { properties: { key: { String: 'dep' } } },
      ],
      relationships: [{ edge_type: 'CALLS' }],
    };
    const store = new HydraDbGraphStore({ token: 'secret', fetch: async () => json({
      columns: ['path'], rows: [[{ type: 'path', value: path }]], next_cursor: null,
    }) });
    await expect(store.impact('target', { maxHops: 2, kinds: ['calls'] }))
      .resolves.toEqual([{ path: ['dep', 'target'], kinds: ['calls'] }]);
  });

  it('projects only present relationship types, writes PageRank once per version, and caches results', async () => {
    const queries: string[] = [];
    const store = new HydraDbGraphStore({ token: 'secret', fetch: async (_url, init) => {
      const query = (JSON.parse(String(init?.body)) as { query: string }).query;
      queries.push(query);
      if (query.includes('RETURN a.id AS id LIMIT 1')) {
        return json({ columns: ['id'], rows: query.includes('[:CALLS]') ? [[{ type: 'vertex_id', value: 1 }]] : [], next_cursor: null });
      }
      if (query.includes('RETURN n.key AS id')) return json({
        columns: ['id', 'score'], rows: [[{ type: 'string', value: 'hub' }, { type: 'float', value: 0.9 }]], next_cursor: null,
      });
      return json({ columns: [], rows: [], next_cursor: null });
    } });
    await store.upsertGraph({}, 'v1');
    await expect(store.hubs(3)).resolves.toEqual([{ id: 'hub', score: 0.9 }]);
    const afterFirst = queries.length;
    await expect(store.hubs(3)).resolves.toEqual([{ id: 'hub', score: 0.9 }]);
    expect(queries).toHaveLength(afterFirst);
    expect(queries.find((query) => query.includes('gds.graph.project'))).toContain("['CALLS']");
    expect(queries.find((query) => query.includes('gds.pageRank.write'))).toContain('tolerance: 0.0001');
  });

  it('loads typed nodes and edges without leaking Hydra vertex ids', async () => {
    const store = new HydraDbGraphStore({ token: 'secret', fetch: async (_url, init) => {
      const query = (JSON.parse(String(init?.body)) as { query: string }).query;
      if (query.includes('RETURN n.key AS id')) return json({
        columns: ['id', 'kind', 'path', 'hasPath', 'name', 'startLine', 'endLine', 'hasRange', 'signature', 'hasSignature', 'fileHash', 'tokens', 'sigTokens'],
        rows: [[
          { type: 'string', value: 'a' }, { type: 'string', value: 'function' }, { type: 'string', value: 'src/a.ts' },
          { type: 'boolean', value: true }, { type: 'string', value: 'a' }, { type: 'integer', value: 1 },
          { type: 'integer', value: 2 }, { type: 'boolean', value: true }, { type: 'string', value: 'function a()' },
          { type: 'boolean', value: true }, { type: 'string', value: 'hash' }, { type: 'integer', value: 3 },
          { type: 'integer', value: 2 },
        ]], next_cursor: null,
      });
      if (query.includes('[r:CALLS]')) return json({
        columns: ['src', 'dst', 'metaJson'], rows: [[
          { type: 'string', value: 'a' }, { type: 'string', value: 'b' }, { type: 'null' },
        ]], next_cursor: null,
      });
      return json({ columns: ['src', 'dst', 'metaJson'], rows: [], next_cursor: null });
    } });
    const pages: { nodes?: GraphNode[]; edges?: GraphEdge[] }[] = [];
    for await (const page of store.loadAll()) pages.push(page);
    expect(pages.flatMap((page) => page.nodes ?? [])).toEqual([node('a', 'a')]);
    expect(pages.flatMap((page) => page.edges ?? [])).toContainEqual(edge('a', 'b'));
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
