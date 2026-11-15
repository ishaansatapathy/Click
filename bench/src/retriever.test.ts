import { describe, expect, it, vi } from 'vitest';

import { FakeStore } from '../../packages/core/src/testing/fakes.js';
import type { Graph, PackedContext } from '../../packages/core/src/types.js';
import type { BenchTask } from './task.js';
import { RetrieverNotWiredError, httpRetriever, inProcessRetriever, realInProcessRetriever } from './retriever.js';

const task: BenchTask = {
  id: 'h-01', source: 'hand', text: 'Improve account loading.', type: 'single-file',
  groundTruth: { files: ['src/a.ts'], symbols: [] }, split: 'test', e2e: false,
};

const packed = { text: '<click_context />', tokens: 10, budget: 4_000 } as PackedContext;

describe('retriever adapters', () => {
  it('keeps unwired adapters behind the Retriever interface', async () => {
    await expect(inProcessRetriever('V1')(task, 4_000)).rejects.toBeInstanceOf(RetrieverNotWiredError);
    await expect(httpRetriever()(task, 4_000)).rejects.toBeInstanceOf(RetrieverNotWiredError);
  });

  it('passes the selected variant to the future in-process getContext', async () => {
    const getContext = vi.fn(async () => packed);
    await expect(inProcessRetriever('V3', getContext)(task, 8_000)).resolves.toBe(packed);
    expect(getContext).toHaveBeenCalledWith(
      { text: task.text, budgetTokens: 8_000, source: 'bench' },
      'V3',
    );
  });

  it('runs the real core pipeline in-process without a network dependency', async () => {
    const graph: Graph = {
      version: 'test-v1', repoCommit: null,
      nodes: [{
        id: 'file:src/a.ts', kind: 'file', name: 'a.ts', path: 'src/a.ts',
        tokens: 10, sigTokens: 0, fileHash: 'abc123',
      }],
      edges: [], chunks: [],
    };
    const result = await realInProcessRetriever('V2', {
      root: '.', graphSnapshot: graph, store: new FakeStore(), graph: null, embedder: null,
    })(task, 4_000);

    expect(result.variant).toBe('V2');
    expect(result.budget).toBe(4_000);
    expect(result.degraded).toContain('semantic-off');
    expect(result.graphVersion).toBe('test-v1');
  });

  it('maps a benchmark task to the daemon context request', async () => {
    const request = vi.fn(async () => packed);
    await expect(httpRetriever({
      baseUrl: 'http://127.0.0.1:3210/', variant: 'V4', token: 'secret', request,
    })(task, 4_000)).resolves.toBe(packed);
    expect(request).toHaveBeenCalledWith('http://127.0.0.1:3210/context', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: { task: task.text, budgetTokens: 4_000, variant: 'V4', source: 'bench' },
      timeoutMs: 5_000,
      retries: 0,
    });
  });
});
