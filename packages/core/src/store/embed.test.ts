import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DiskCache } from '../util/diskCache.js';
import {
  DEFAULT_OPENAI_EMBEDDING_DIMS,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  FakeEmbedder,
  OpenAIEmbedder,
  embeddingCacheKey,
  type OpenAIEmbeddingsClient,
} from './embed.js';

function fakeClient(calls: { params: unknown; signal?: AbortSignal }[]): OpenAIEmbeddingsClient {
  return {
    embeddings: {
      async create(params, options) {
        calls.push({ params, signal: options?.signal });
        return {
          data: params.input.map((_text, index) => ({
            index,
            embedding: Array.from({ length: params.dimensions }, (_, dimension) => dimension === index ? 1 : 0),
          })),
        };
      },
    },
  };
}

async function freshCache(): Promise<DiskCache> {
  const directory = await mkdtemp(join(tmpdir(), 'click-embed-test-'));
  return new DiskCache('embed', { dir: directory });
}

describe('OpenAIEmbedder', () => {
  it('uses the verified defaults and sends API-supported fields only', async () => {
    const calls: { params: unknown; signal?: AbortSignal }[] = [];
    const controller = new AbortController();
    const embedder = new OpenAIEmbedder({ client: fakeClient(calls), cache: await freshCache(), dims: 4 });

    const vectors = await embedder.embed(['order store', 'checkout route'], 'document', controller.signal);

    expect(embedder.model).toBe(DEFAULT_OPENAI_EMBEDDING_MODEL);
    expect(DEFAULT_OPENAI_EMBEDDING_DIMS).toBe(1_536);
    expect(vectors).toHaveLength(2);
    expect(calls).toEqual([{
      params: {
        model: 'text-embedding-3-small',
        input: ['order store', 'checkout route'],
        encoding_format: 'float',
        dimensions: 4,
      },
      signal: controller.signal,
    }]);
    expect(calls[0]!.params).not.toHaveProperty('input_type');
  });

  it('deduplicates misses, batches requests, and restores original order', async () => {
    const calls: { params: unknown; signal?: AbortSignal }[] = [];
    const embedder = new OpenAIEmbedder({ client: fakeClient(calls), cache: await freshCache(), dims: 3, batchSize: 2 });

    const vectors = await embedder.embed(['alpha', 'beta', 'alpha', 'gamma'], 'query');

    expect(calls).toHaveLength(2);
    expect((calls[0]!.params as { input: string[] }).input).toEqual(['alpha', 'beta']);
    expect((calls[1]!.params as { input: string[] }).input).toEqual(['gamma']);
    expect(Array.from(vectors[0]!)).toEqual(Array.from(vectors[2]!));
  });

  it('caches each vector by model, input type, and text hash', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'click-embed-'));
    const cache = new DiskCache('embed', { dir: directory });
    const calls: { params: unknown; signal?: AbortSignal }[] = [];
    const first = new OpenAIEmbedder({ client: fakeClient(calls), cache, dims: 2 });
    await first.embed(['same text'], 'document');
    await first.embed(['same text'], 'document');
    expect(calls).toHaveLength(1);

    await first.embed(['same text'], 'query');
    expect(calls).toHaveLength(2);
    expect(embeddingCacheKey('m', 'document', 'x')).not.toBe(embeddingCacheKey('m', 'query', 'x'));
    expect(embeddingCacheKey('m', 'query', 'x')).not.toBe(embeddingCacheKey('other', 'query', 'x'));
  });

  it('validates inputs and response shape without making a real request', async () => {
    const bad: OpenAIEmbeddingsClient = {
      embeddings: { create: async () => ({ data: [{ index: 0, embedding: [1] }] }) },
    };
    await expect(new OpenAIEmbedder({ client: bad, cache: await freshCache(), dims: 2 }).embed(['x'], 'query'))
      .rejects.toThrow('must contain 2 finite numbers');
    await expect(new OpenAIEmbedder({ client: bad, cache: await freshCache() }).embed([''], 'query'))
      .rejects.toThrow('empty input');
  });

  it('re-exports the deterministic FakeEmbedder', async () => {
    const embedder = new FakeEmbedder(8);
    expect(await embedder.embed(['useOrderStore'], 'query')).toHaveLength(1);
  });
});
