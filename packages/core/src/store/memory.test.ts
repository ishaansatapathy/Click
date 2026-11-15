import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ChunkRecord } from '../types.js';
import { runStoreContract } from './contract.js';
import { MemoryStore } from './memory.js';

runStoreContract(() => new MemoryStore({ pageSize: 1 }), 'MemoryStore');

const chunk = (id: string, text: string, vector: number[]): ChunkRecord => ({
  id,
  nodeId: `sym:src/a.ts#${id}`,
  path: 'src/a.ts',
  range: { startLine: 1, endLine: 2 },
  text,
  vector,
});

describe('MemoryStore', () => {
  it('fuses BM25 and cosine rankings with RRF', async () => {
    const store = new MemoryStore();
    await store.upsert({ chunks: [
      chunk('both', 'submit order payment', [0, 1]),
      chunk('lexical', 'submit order payment', [1, 0]),
      chunk('semantic', 'format a date', [0, 1]),
    ] }, 'v1');

    const hits = await store.hybridQuery({ text: 'submit order', vector: [0, 1], k: 3 });
    expect(hits[0]?.id).toBe('both');
    expect(hits.map(({ id }) => id)).toEqual(expect.arrayContaining(['lexical', 'semantic']));
  });

  it('persists atomically and restores all state from JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'click-memory-store-'));
    const path = join(directory, 'nested', 'store.json');
    const first = new MemoryStore(path);
    await first.upsert({ chunks: [chunk('persisted', 'persistent order context', [1, 0])] }, 'index-v1');
    await first.putConventions([{ id: 'c1', text: 'Keep it small.', source: 'AGENTS.md', validFrom: '2026-11-15', validTo: null }]);

    const snapshot = JSON.parse(await readFile(path, 'utf8')) as { v: number; indexVersion: string };
    expect(snapshot).toMatchObject({ v: 1, indexVersion: 'index-v1' });

    const restored = new MemoryStore({ persistencePath: path, pageSize: 1 });
    expect((await restored.hybridQuery({ text: 'persistent order', k: 1 }))[0]?.id).toBe('persisted');
    expect(await restored.getConventions()).toHaveLength(1);
    const pages = [];
    for await (const page of restored.loadAll()) pages.push(page);
    expect(pages.flatMap((page) => page.chunks ?? []).map(({ id }) => id)).toEqual(['persisted']);
  });

  it('filters node search by kind and honours an aborted signal', async () => {
    const store = new MemoryStore();
    await store.upsert({ nodes: [
      { id: 'store:x', kind: 'store', path: 'src/x.ts', name: 'useOrderStore', tokens: 1, sigTokens: 1, fileHash: 'h' },
      { id: 'fn:x', kind: 'function', path: 'src/x.ts', name: 'useOrderStore', tokens: 1, sigTokens: 1, fileHash: 'h' },
    ] }, 'v1');
    expect((await store.hybridQuery({ text: 'order store', k: 5, kinds: ['store'] })).map(({ id }) => id)).toEqual(['store:x']);

    const controller = new AbortController();
    controller.abort(new Error('deadline'));
    await expect(store.hybridQuery({ text: 'order', k: 1 }, controller.signal)).rejects.toThrow('deadline');
  });
});
