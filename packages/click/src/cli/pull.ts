import { resolve } from 'node:path';

import { graphVersion } from '../../../core/src/indexer/build.js';
import { HydraDbGraphStore } from '../../../core/src/store/hydradb-graph.js';
import { MemoryStore } from '../../../core/src/store/memory.js';
import type { GraphStore, Store } from '../../../core/src/store/types.js';
import type { Graph, GraphEdge, GraphNode } from '../../../core/src/types.js';
import { pushPaths, readSnapshot, writeSnapshot } from './push-state.js';

export interface PullIo { out: (text: string) => void; err: (text: string) => void }
type VersionedGraphStore = GraphStore & { getIndexVersion(signal?: AbortSignal): Promise<string | null> };
export interface PullDeps { graph?: VersionedGraphStore; store?: Store }

export const PULL_USAGE = 'usage: click pull [--root <dir>]';

function parseRoot(argv: readonly string[], cwd: string): string | { error: string } {
  let root = cwd;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--root') {
      const value = argv[++index];
      if (!value) return { error: '--root needs a directory' };
      root = resolve(cwd, value);
    } else return { error: `unknown option ${flag}` };
  }
  return root;
}

export async function runPull(argv: readonly string[], io: PullIo, cwd = process.cwd(), deps: PullDeps = {}): Promise<number> {
  const parsed = parseRoot(argv, cwd);
  if (typeof parsed !== 'string') {
    io.err(`${parsed.error}\n${PULL_USAGE}`);
    return 2;
  }
  const root = parsed;
  const graphStore = deps.graph ?? new HydraDbGraphStore();
  const version = await graphStore.getIndexVersion();
  if (!version) {
    io.err('HydraDB has no pushed Click graph');
    return 1;
  }
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for await (const page of graphStore.loadAll()) {
    nodes.push(...(page.nodes ?? []));
    edges.push(...(page.edges ?? []));
  }
  nodes.sort((a, b) => compare(a.id, b.id));
  edges.sort((a, b) => compare(a.key, b.key));
  const computed = graphVersion(
    nodes.map((node) => node.id),
    edges.map((edge) => edge.key),
    nodes.filter((node) => node.kind === 'file').map((node) => ({ path: node.path!, hash: node.fileHash })),
  );
  if (computed !== version) throw new Error(`HydraDB graph version mismatch: metadata ${version}, computed ${computed}`);

  const previous = await readSnapshot(root);
  const chunks = previous?.graph.version === version ? previous.chunks : [];
  const graph: Graph = { version, repoCommit: previous?.graph.version === version ? previous.graph.repoCommit : null, nodes, edges, chunks: chunks.map(({ id, nodeId, path, range }) => ({ id, nodeId, path, range })) };
  const store = deps.store ?? new MemoryStore(pushPaths(root).memstore);
  if (previous) {
    await store.remove({
      nodeIds: previous.graph.nodes.map((node) => node.id),
      edgeKeys: previous.graph.edges.map((edge) => edge.key),
      chunkIds: previous.chunks.map((chunk) => chunk.id),
    });
  }
  await store.upsert({ nodes, edges, ...(chunks.length ? { chunks } : {}) }, version);
  await writeSnapshot(root, { v: 1, graph, chunks });
  io.out(`Pulled ${version} (${nodes.length} nodes, ${edges.length} edges${chunks.length ? `, ${chunks.length} local chunks retained` : ''})`);
  return 0;
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
