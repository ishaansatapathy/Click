import { describe, expect, it, vi } from 'vitest';

import type { PackedContext } from '../../packages/core/src/types.js';
import type { BenchTask } from './task.js';
import { RetrieverNotWiredError, httpRetriever, inProcessRetriever } from './retriever.js';

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
