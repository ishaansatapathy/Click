import { join, resolve } from 'node:path';

import { buildIndex, type BuildResult } from '../../../core/src/indexer/build.js';
import { diffGraphs } from '../../../core/src/indexer/incremental.js';
import { indexSemanticChunks } from '../../../core/src/retrieve/semantic.js';
import { DiskCache } from '../../../core/src/util/diskCache.js';
import { OpenAIEmbedder } from '../../../core/src/store/embed.js';
import { HydraDbGraphStore } from '../../../core/src/store/hydradb-graph.js';
import { MemoryStore } from '../../../core/src/store/memory.js';
import type { Embedder, GraphStore, Store } from '../../../core/src/store/types.js';
import type { ChunkRecord } from '../../../core/src/types.js';
import { pushPaths, readLastPushedVersion, readSnapshot, writeLastPushedVersion, writeSnapshot } from './push-state.js';

export interface PushIo { out: (text: string) => void; err: (text: string) => void }
export interface PushDeps {
  build?: (root: string) => Promise<BuildResult>;
  graph?: GraphStore;
  store?: Store;
  embedder?: Embedder;
}

type VersionedGraphStore = GraphStore & { getIndexVersion(signal?: AbortSignal): Promise<string | null> };

interface PushArgs { root: string; full: boolean; openaiEmbeddings: boolean }
export const PUSH_USAGE = 'usage: click push [--root <dir>] [--full] [--openai-embeddings]';

export function parsePushArgs(argv: readonly string[], cwd: string): PushArgs | string {
  const args: PushArgs = { root: cwd, full: false, openaiEmbeddings: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--root') {
      const value = argv[++index];
      if (!value) return '--root needs a directory';
      args.root = resolve(cwd, value);
    } else if (flag === '--full') args.full = true;
    else if (flag === '--openai-embeddings') args.openaiEmbeddings = true;
    else return `unknown option ${flag}`;
  }
  return args;
}

export async function runPush(argv: readonly string[], io: PushIo, cwd = process.cwd(), deps: PushDeps = {}): Promise<number> {
  const args = parsePushArgs(argv, cwd);
  if (typeof args === 'string') {
    io.err(`${args}\n${PUSH_USAGE}`);
    return 2;
  }
  loadLocalEnv(cwd);
  const paths = pushPaths(args.root);
  const build = await (deps.build ?? ((root) => buildIndex(root)))(args.root);
  const graph = deps.graph ?? new HydraDbGraphStore();
  const store = deps.store ?? new MemoryStore(paths.memstore);
  const previousVersion = await readLastPushedVersion(args.root);
  if (!args.full && previousVersion === build.graph.version && await remoteVersion(graph) === build.graph.version) {
    io.out(`graph ${build.graph.version} already in HydraDB (nothing to push)`);
    return 0;
  }
  const previous = previousVersion ? await readSnapshot(args.root, previousVersion) : null;
  const full = args.full || previous === null;

  let changedNodes: number;
  let changedEdges: number;
  try {
    if (full) {
      if (previous) {
        await graph.removeGraph({ edgeKeys: previous.graph.edges.map((edge) => edge.key), nodeIds: previous.graph.nodes.map((node) => node.id) });
      }
      await graph.upsertGraph({ nodes: build.graph.nodes, edges: build.graph.edges }, build.graph.version);
      changedNodes = build.graph.nodes.length;
      changedEdges = build.graph.edges.length;
    } else {
      const delta = diffGraphs(previous, build);
      await graph.removeGraph({ edgeKeys: delta.deleteEdgeKeys, nodeIds: delta.deleteNodeIds });
      await graph.upsertGraph({ nodes: delta.upsertNodes, edges: delta.upsertEdges }, build.graph.version);
      changedNodes = delta.upsertNodes.length + delta.deleteNodeIds.length;
      changedEdges = delta.upsertEdges.length + delta.deleteEdgeKeys.length;
    }
  } catch (error) {
    if (!isReusedIdentity(error) || await remoteVersion(graph) !== build.graph.version) throw error;
    // HydraDB applied this identity on an earlier attempt. Its graph metadata proves the target version is already complete.
    changedNodes = 0;
    changedEdges = 0;
  }

  if (full) {
    if (previous) {
      await store.remove({
        edgeKeys: previous.graph.edges.map((edge) => edge.key),
        nodeIds: previous.graph.nodes.map((node) => node.id),
        chunkIds: previous.chunks.map((chunk) => chunk.id),
      });
    }
    await store.upsert({ nodes: build.graph.nodes, edges: build.graph.edges }, build.graph.version);
  } else {
    const delta = diffGraphs(previous, build);
    await store.remove({ nodeIds: delta.deleteNodeIds, edgeKeys: delta.deleteEdgeKeys, chunkIds: delta.deleteChunkIds });
    await store.upsert({ nodes: delta.upsertNodes, edges: delta.upsertEdges }, build.graph.version);
  }

  let chunks: ChunkRecord[];
  if (args.openaiEmbeddings || deps.embedder) {
    const embedder = deps.embedder ?? new OpenAIEmbedder({ cache: new DiskCache('embed', { dir: paths.cacheDir }) });
    chunks = await indexSemanticChunks(build.chunks, build.graph.version, { store, embedder });
  } else {
    chunks = build.chunks.map((chunk) => structuredClone(chunk));
    await store.upsert({ chunks }, build.graph.version);
  }
  await store.putConventions(build.conventions);
  await writeSnapshot(args.root, { v: 1, graph: build.graph, chunks });
  await writeLastPushedVersion(args.root, build.graph.version);
  io.out(`Pushed ${build.graph.version} (${full ? 'full' : 'delta'}: ${changedNodes} node changes, ${changedEdges} edge changes, ${chunks.length} chunks${args.openaiEmbeddings || deps.embedder ? ' embedded' : ' local-only'})`);
  return 0;
}

async function remoteVersion(graph: GraphStore): Promise<string | null> {
  const candidate = graph as Partial<VersionedGraphStore>;
  return typeof candidate.getIndexVersion === 'function' ? candidate.getIndexVersion() : null;
}

function isReusedIdentity(error: unknown): boolean {
  return error instanceof Error && /idempotency identity was reused for a different request/i.test(error.message);
}

function loadLocalEnv(cwd: string): void {
  try {
    process.loadEnvFile(join(cwd, '.env'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
