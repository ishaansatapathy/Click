import OpenAI from 'openai';

import { DiskCache, type DiskCacheOptions } from '../util/diskCache.js';
import { sha1 } from '../util/hash.js';
import { countTokens } from '../util/tokens.js';
import type { Embedder } from './types.js';

export { FakeEmbedder } from '../testing/fakes.js';

export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
export const DEFAULT_OPENAI_EMBEDDING_DIMS = 1_536;
export const OPENAI_EMBEDDING_USD_PER_MILLION_TOKENS = 0.02;
export const OPENAI_EMBEDDING_MAX_INPUTS = 2_048;
export const OPENAI_EMBEDDING_MAX_INPUT_TOKENS = 8_192;
export const OPENAI_EMBEDDING_MAX_BATCH_TOKENS = 300_000;

export interface OpenAIEmbeddingsClient {
  embeddings: {
    create(params: {
      model: string;
      input: string[];
      encoding_format: 'float';
      dimensions: number;
    }, options?: { signal?: AbortSignal }): Promise<{
      data: { embedding: number[]; index: number }[];
    }>;
  };
}

export interface OpenAIEmbedderOptions {
  model?: string;
  dims?: number;
  client?: OpenAIEmbeddingsClient;
  apiKey?: string;
  cache?: DiskCache;
  cacheOptions?: DiskCacheOptions;
  /** Test/operational override; the API hard limit remains 2,048. */
  batchSize?: number;
}

interface PendingInput {
  key: string;
  text: string;
  tokens: number;
}

/** OpenAI embeddings with per-input persistent caching and API-limit-aware batches. */
export class OpenAIEmbedder implements Embedder {
  readonly model: string;
  readonly dims: number;
  private readonly cache: DiskCache;
  private readonly batchSize: number;
  private readonly injectedClient: OpenAIEmbeddingsClient | undefined;
  private readonly apiKey: string | undefined;
  private runtimeClient: OpenAIEmbeddingsClient | undefined;

  constructor(options: OpenAIEmbedderOptions = {}) {
    this.model = options.model ?? DEFAULT_OPENAI_EMBEDDING_MODEL;
    this.dims = options.dims ?? DEFAULT_OPENAI_EMBEDDING_DIMS;
    this.cache = options.cache ?? new DiskCache('embed', options.cacheOptions);
    this.batchSize = options.batchSize ?? OPENAI_EMBEDDING_MAX_INPUTS;
    this.injectedClient = options.client;
    this.apiKey = options.apiKey;
    if (!Number.isInteger(this.dims) || this.dims < 1) throw new Error('OpenAIEmbedder dims must be a positive integer');
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > OPENAI_EMBEDDING_MAX_INPUTS) {
      throw new Error(`OpenAIEmbedder batchSize must be between 1 and ${OPENAI_EMBEDDING_MAX_INPUTS}`);
    }
  }

  async embed(texts: string[], inputType: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array[]> {
    throwIfAborted(signal);
    if (!texts.length) return [];

    const unique = new Map<string, PendingInput>();
    for (const text of texts) {
      if (!text.length) throw new Error('OpenAI embeddings do not accept empty input');
      const tokens = countTokens(text);
      if (tokens > OPENAI_EMBEDDING_MAX_INPUT_TOKENS) {
        throw new Error(`OpenAI embedding input exceeds ${OPENAI_EMBEDDING_MAX_INPUT_TOKENS} tokens`);
      }
      const key = embeddingCacheKey(this.model, inputType, text);
      if (!unique.has(key)) unique.set(key, { key, text, tokens });
    }

    const vectors = new Map<string, number[]>();
    const orderedInputs = [...unique.values()];
    const cachedInputs = await Promise.all(orderedInputs.map((input) => this.cache.get<number[]>(input.key)));
    const misses: PendingInput[] = [];
    orderedInputs.forEach((input, index) => {
      const cached = cachedInputs[index];
      if (cached === undefined) misses.push(input);
      else {
        assertVector(cached, this.dims, `cached embedding ${input.key}`);
        vectors.set(input.key, cached);
      }
    });

    for (const batch of makeBatches(misses, this.batchSize)) {
      throwIfAborted(signal);
      const response = await this.client().embeddings.create({
        model: this.model,
        input: batch.map(({ text }) => text),
        encoding_format: 'float',
        dimensions: this.dims,
      }, { signal });
      const received = new Map<number, number[]>();
      for (const item of response.data) {
        if (!Number.isInteger(item.index) || item.index < 0 || item.index >= batch.length || received.has(item.index)) {
          throw new Error(`OpenAI returned invalid embedding index ${item.index}`);
        }
        assertVector(item.embedding, this.dims, `OpenAI embedding ${item.index}`);
        received.set(item.index, item.embedding);
      }
      if (received.size !== batch.length) throw new Error(`OpenAI returned ${received.size} embeddings for ${batch.length} inputs`);
      await Promise.all(batch.map(async (input, index) => {
        const vector = received.get(index)!;
        vectors.set(input.key, vector);
        await this.cache.set(input.key, vector);
      }));
    }

    throwIfAborted(signal);
    return texts.map((text) => new Float32Array(vectors.get(embeddingCacheKey(this.model, inputType, text))!));
  }

  private client(): OpenAIEmbeddingsClient {
    if (this.injectedClient) return this.injectedClient;
    if (this.runtimeClient) return this.runtimeClient;
    const apiKey = this.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('no OpenAI credentials: set OPENAI_API_KEY');
    this.runtimeClient = new OpenAI({ apiKey, maxRetries: 2, timeout: 30_000 }) as unknown as OpenAIEmbeddingsClient;
    return this.runtimeClient;
  }
}

export function embeddingCacheKey(model: string, inputType: 'document' | 'query', text: string): string {
  return sha1(`${model}\0${inputType}\0${sha1(text)}`);
}

function makeBatches(inputs: PendingInput[], maxInputs: number): PendingInput[][] {
  const batches: PendingInput[][] = [];
  let current: PendingInput[] = [];
  let tokens = 0;
  for (const input of inputs) {
    if (current.length && (current.length >= maxInputs || tokens + input.tokens > OPENAI_EMBEDDING_MAX_BATCH_TOKENS)) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(input);
    tokens += input.tokens;
  }
  if (current.length) batches.push(current);
  return batches;
}

function assertVector(vector: number[], dims: number, source: string): void {
  if (vector.length !== dims || vector.some((value) => !Number.isFinite(value))) {
    throw new Error(`${source} must contain ${dims} finite numbers`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
}
