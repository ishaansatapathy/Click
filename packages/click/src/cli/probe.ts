import { join, resolve } from 'node:path';

import { buildIndex, type BuildResult } from '../../../core/src/indexer/build.js';
import { OpenAIEmbedder } from '../../../core/src/store/embed.js';
import { HydraDbGraphStore } from '../../../core/src/store/hydradb-graph.js';
import type { Embedder, GraphStore } from '../../../core/src/store/types.js';
import { DiskCache } from '../../../core/src/util/diskCache.js';
import { pushPaths } from './push-state.js';

export interface ProbeIo { out: (text: string) => void; err: (text: string) => void }
type ProbeGraphStore = GraphStore & { getIndexVersion?(signal?: AbortSignal): Promise<string | null> };
export interface ProbeDeps {
  build?: (root: string) => Promise<BuildResult>;
  graph?: ProbeGraphStore;
  embedder?: Embedder;
}
export interface ProbeResult {
  version: string;
  neighbourhood: { runs: number; p50Ms: number; p95Ms: number; edges: number };
  impact: { ms: number; paths: number };
  hubs: { ms: number; count: number };
  embedding: { ms: number; dims: number; model: string };
}

export const PROBE_USAGE = 'usage: click probe [--root <dir>] [--query <text>] [--openai-embedding]';

function percentile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0;
}

export async function runProbe(argv: readonly string[], io: ProbeIo, cwd = process.cwd(), deps: ProbeDeps = {}): Promise<number> {
  let root = cwd;
  let query = 'add a loading state to checkout';
  let openaiEmbedding = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    const value = () => argv[++index];
    if (flag === '--root') {
      const next = value();
      if (!next) return usageError('--root needs a directory', io);
      root = resolve(cwd, next);
    } else if (flag === '--query') {
      const next = value();
      if (!next) return usageError('--query needs text', io);
      query = next;
    } else if (flag === '--openai-embedding') openaiEmbedding = true;
    else return usageError(`unknown option ${flag}`, io);
  }
  loadLocalEnv(cwd);
  const build = await (deps.build ?? ((repo) => buildIndex(repo)))(root);
  const graph = deps.graph ?? new HydraDbGraphStore();
  await graph.getIndexVersion?.();
  const degrees = new Map<string, number>();
  for (const edge of build.graph.edges) {
    degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1);
    degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1);
  }
  const seeds = [...degrees].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([id]) => id);
  if (!seeds.length) throw new Error('cannot probe an empty graph');
  const latencies: number[] = [];
  let edgeCount = 0;
  for (let run = 0; run < 20; run++) {
    const start = performance.now();
    const rows = await graph.neighbourhood(seeds, { hops: 2, maxFrontier: 200, maxEdges: 2_000 });
    latencies.push(performance.now() - start);
    edgeCount = rows.length;
  }
  latencies.sort((a, b) => a - b);
  const target = [...build.graph.nodes].sort((a, b) => (degrees.get(b.id) ?? 0) - (degrees.get(a.id) ?? 0))[0]!.id;
  let start = performance.now();
  const paths = await graph.impact(target, { maxHops: 2, limit: 500 });
  const impactMs = performance.now() - start;
  start = performance.now();
  const hubs = await graph.hubs(15);
  const hubsMs = performance.now() - start;
  start = performance.now();
  const embedder = deps.embedder ?? (openaiEmbedding ? new OpenAIEmbedder({ cache: new DiskCache('embed', { dir: pushPaths(root).cacheDir }) }) : undefined);
  const [vector] = embedder ? await embedder.embed([query], 'query') : [];
  const embeddingMs = performance.now() - start;
  const result: ProbeResult = {
    version: build.graph.version,
    neighbourhood: { runs: 20, p50Ms: round(percentile(latencies, 0.5)), p95Ms: round(percentile(latencies, 0.95)), edges: edgeCount },
    impact: { ms: round(impactMs), paths: paths.length },
    hubs: { ms: round(hubsMs), count: hubs.length },
    embedding: { ms: round(embeddingMs), dims: vector?.length ?? 0, model: embedder?.model ?? 'off' },
  };
  io.out(JSON.stringify(result, null, 2));
  return 0;
}

function usageError(message: string, io: ProbeIo): number {
  io.err(`${message}\n${PROBE_USAGE}`);
  return 2;
}

function round(value: number): number { return Math.round(value * 10) / 10; }

function loadLocalEnv(cwd: string): void {
  try { process.loadEnvFile(join(cwd, '.env')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
