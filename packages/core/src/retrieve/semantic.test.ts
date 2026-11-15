import { describe, expect, it } from 'vitest';

import type { ChunkRecord } from '../types.js';
import { FakeEmbedder } from '../testing/fakes.js';
import { Deadline, DeadlineError } from '../util/deadline.js';
import { MemoryStore } from '../store/memory.js';
import type { Embedder } from '../store/types.js';
import { embedChunks, indexSemanticChunks, semanticSeeds } from './semantic.js';

const chunks: ChunkRecord[] = [
  { id: 'chunk:checkout#submit#0', nodeId: 'sym:checkout#submit', path: 'checkout.ts', range: { startLine: 1, endLine: 2 }, text: 'submit checkout payment order' },
  { id: 'chunk:dates#format#0', nodeId: 'sym:dates#format', path: 'dates.ts', range: { startLine: 1, endLine: 2 }, text: 'format calendar date timezone' },
];

describe('semantic retrieval', () => {
  it('off mode returns no seeds without embedding or searching', async () => {
    const embedder = new FakeEmbedder(16);
    const store = new MemoryStore();
    await expect(semanticSeeds('checkout', { mode: 'off', k: 10 }, { store, embedder })).resolves.toEqual([]);
    expect(embedder.calls).toBe(0);
  });

  it('embeds chunks as documents, stores them, then makes one query embedding', async () => {
    const embedder = new FakeEmbedder(64);
    const store = new MemoryStore();
    const embedded = await indexSemanticChunks(chunks, 'v1', { store, embedder });
    expect(embedder.calls).toBe(1);
    expect(embedded.every((chunk) => chunk.vector?.length === 64)).toBe(true);
    expect(chunks.every((chunk) => chunk.vector === undefined)).toBe(true);

    const hits = await semanticSeeds('submit payment', { mode: 'local', k: 2 }, { store, embedder });
    expect(embedder.calls).toBe(2);
    expect(hits[0]?.id).toBe('chunk:checkout#submit#0');
  });

  it('embeds an entire index through the embedder batching boundary', async () => {
    const embedder = new FakeEmbedder(8);
    const result = await embedChunks(chunks, embedder);
    expect(embedder.calls).toBe(1);
    expect(result.map((chunk) => chunk.vector?.length)).toEqual([8, 8]);
  });

  it('honours both an external AbortSignal and the deadline', async () => {
    const store = new MemoryStore();
    const slow: Embedder = {
      model: 'slow', dims: 2,
      embed: async (_texts, _inputType, signal) => new Promise((_resolve, reject) => {
        const onAbort = () => reject(signal?.reason);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      }),
    };
    await expect(semanticSeeds('x', { mode: 'local', k: 1, deadline: new Deadline(5) }, { store, embedder: slow }))
      .rejects.toBeInstanceOf(DeadlineError);

    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(semanticSeeds('x', { mode: 'local', k: 1, signal: controller.signal }, { store, embedder: new FakeEmbedder() }))
      .rejects.toThrow('cancelled');
  });

  it('validates k and inconsistent embedder output', async () => {
    const store = new MemoryStore();
    const empty: Embedder = { model: 'empty', dims: 1, embed: async () => [] };
    await expect(semanticSeeds('x', { mode: 'local', k: 0 }, { store, embedder: empty })).rejects.toThrow('positive integer');
    await expect(embedChunks(chunks, empty)).rejects.toThrow('0 vectors for 2 chunks');
  });
});
