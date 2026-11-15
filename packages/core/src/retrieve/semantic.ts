import type { ChunkRecord } from '../types.js';
import type { Deadline } from '../util/deadline.js';
import type { Embedder, ScoredId, Store } from '../store/types.js';

export interface SemanticSearchOptions {
  mode: 'local' | 'off';
  k: number;
  deadline?: Deadline;
  signal?: AbortSignal;
}

export interface SemanticDeps {
  store: Store;
  embedder: Embedder;
}

/** One query embedding followed by local hybrid search over persisted chunk vectors. */
export async function semanticSeeds(
  text: string,
  options: SemanticSearchOptions,
  deps: SemanticDeps,
): Promise<ScoredId[]> {
  if (options.mode === 'off') return [];
  if (!Number.isInteger(options.k) || options.k < 1) throw new Error('semantic k must be a positive integer');
  const signal = combinedSignal(options.signal, options.deadline?.signal);
  throwIfAborted(signal);
  const [vector] = await deps.embedder.embed([text], 'query', signal);
  if (!vector) throw new Error('embedder returned no query vector');
  throwIfAborted(signal);
  return deps.store.hybridQuery({ text, vector: Array.from(vector), k: options.k }, signal);
}

/** Compute cached document embeddings in API-sized batches, without mutating the caller's chunk records. */
export async function embedChunks(
  chunks: readonly ChunkRecord[],
  embedder: Embedder,
  signal?: AbortSignal,
): Promise<ChunkRecord[]> {
  throwIfAborted(signal);
  if (!chunks.length) return [];
  const vectors = await embedder.embed(chunks.map((chunk) => chunk.text), 'document', signal);
  if (vectors.length !== chunks.length) {
    throw new Error(`embedder returned ${vectors.length} vectors for ${chunks.length} chunks`);
  }
  throwIfAborted(signal);
  return chunks.map((chunk, index) => ({ ...structuredClone(chunk), vector: Array.from(vectors[index]!) }));
}

/** Index-time semantic write: embedding cache makes unchanged chunks free on subsequent builds. */
export async function indexSemanticChunks(
  chunks: readonly ChunkRecord[],
  indexVersion: string,
  deps: SemanticDeps,
  signal?: AbortSignal,
): Promise<ChunkRecord[]> {
  const embedded = await embedChunks(chunks, deps.embedder, signal);
  if (embedded.length) await deps.store.upsert({ chunks: embedded }, indexVersion);
  return embedded;
}

function combinedSignal(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return present.length ? AbortSignal.any(present) : undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
}
