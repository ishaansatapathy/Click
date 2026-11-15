// PROMPTS 111 / 113: what to save after an index or a re-index.
//   local first (the snapshot on disk, the chunk store, conventions), HydraDB in the background (GraphSync).
// Chunk embeddings are computed after the fact when an embedder is configured, so a re-index is never held up by the network.

import { indexSemanticChunks } from '../../../core/src/retrieve/semantic.js';
import type { Embedder, Store } from '../../../core/src/store/types.js';
import type { ChunkRecord, Convention, Graph, GraphDelta } from '../../../core/src/types.js';
import type { Logger } from '../../../core/src/util/log.js';
import { writeSnapshot } from '../cli/push-state.js';
import { changeFromDelta, fullChange, type GraphSync } from './graphsync.js';

export interface PersistDeps {
  root: string;
  store: Store;
  sync: GraphSync | null;
  embedder?: Embedder | undefined;
  log: Logger;
}

export class Persister {
  /** Background embedding work in progress, so callers (tests, shutdown) can wait for it. */
  private embedding: Promise<void> = Promise.resolve();

  constructor(private readonly d: PersistDeps) {}

  /** Only the local snapshot (the graph came from HydraDB, so there is nothing to push back). */
  async saveSnapshot(graph: Graph, chunks: ChunkRecord[]): Promise<void> {
    await writeSnapshot(this.d.root, { v: 1, graph, chunks });
  }

  /** A complete index: snapshot, store contents, and (in the background) the whole graph into HydraDB. */
  async saveFull(graph: Graph, chunks: ChunkRecord[], conventions: Convention[]): Promise<void> {
    await writeSnapshot(this.d.root, { v: 1, graph, chunks });
    await this.d.store.upsert({ nodes: graph.nodes, edges: graph.edges, chunks }, graph.version);
    await this.d.store.putConventions(conventions);
    this.d.sync?.push(fullChange(graph));
    this.embed(chunks, graph.version);
  }

  /** An incremental update: the new snapshot, the delta in the store, and the delta into HydraDB in the background. */
  async saveDelta(graph: Graph, chunks: ChunkRecord[], conventions: Convention[], delta: GraphDelta): Promise<void> {
    await writeSnapshot(this.d.root, { v: 1, graph, chunks });
    await this.d.store.remove({ nodeIds: delta.deleteNodeIds, edgeKeys: delta.deleteEdgeKeys, chunkIds: delta.deleteChunkIds });
    await this.d.store.upsert({ nodes: delta.upsertNodes, edges: delta.upsertEdges, chunks: delta.upsertChunks }, graph.version);
    await this.d.store.putConventions(conventions);
    this.d.sync?.push(changeFromDelta(delta, graph.version));
    this.embed(delta.upsertChunks, graph.version);
  }

  private embed(chunks: readonly ChunkRecord[], version: string): void {
    const embedder = this.d.embedder;
    if (!embedder || chunks.length === 0) return;
    this.embedding = this.embedding.then(() =>
      indexSemanticChunks(chunks, version, { store: this.d.store, embedder }).then(
        () => undefined,
        (e: unknown) => this.d.log.warn('embedding chunks failed; semantic seeds stay as they were', { error: e }),
      ),
    );
  }

  /** Wait for background embedding (tests, graceful shutdown). */
  settled(): Promise<void> {
    return this.embedding;
  }
}
