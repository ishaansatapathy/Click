import type { PackedContext } from '../../packages/core/src/types.js';
import { fetchJson } from '../../packages/core/src/util/http.js';
import type { BenchTask } from './task.js';

export type Retriever = (task: BenchTask, budget: number) => Promise<PackedContext>;

export interface InProcessRequest {
  text: string;
  budgetTokens: number;
  source: 'bench';
}

export type InProcessGetContext = (
  task: InProcessRequest,
  variant: string,
) => Promise<PackedContext>;

export function inProcessRetriever(variant: string, getContext?: InProcessGetContext): Retriever {
  return async (task, budget) => {
    if (!getContext) throw new RetrieverNotWiredError('in-process', 'prompt 094 has not shipped getContext yet');
    return getContext({ text: task.text, budgetTokens: budget, source: 'bench' }, variant);
  };
}

export interface HttpRetrieverOptions {
  baseUrl: string;
  variant: string;
  token?: string;
  request?: typeof fetchJson<PackedContext>;
}

export function httpRetriever(options?: HttpRetrieverOptions): Retriever {
  return async (task, budget) => {
    if (!options) throw new RetrieverNotWiredError('http', 'prompt 115 has not shipped the daemon endpoint yet');
    const request = options.request ?? fetchJson<PackedContext>;
    const headers = options.token ? { authorization: `Bearer ${options.token}` } : undefined;
    return request(`${options.baseUrl.replace(/\/$/, '')}/context`, {
      method: 'POST',
      headers,
      body: { task: task.text, budgetTokens: budget, variant: options.variant, source: 'bench' },
      timeoutMs: 5_000,
      retries: 0,
    });
  };
}

export class RetrieverNotWiredError extends Error {
  constructor(readonly retriever: 'in-process' | 'http', reason: string) {
    super(`${retriever} retriever is not wired: ${reason}`);
    this.name = 'RetrieverNotWiredError';
  }
}
