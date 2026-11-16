// PROMPTS 158: does adding git co-change edges to the graph help? V3 over the local replica (V3r) with and without `co_changed`
// edges mined from the history before the pinned commit H, with EVERY benchmark task's commit excluded (their diffs are the
// ground truth, so they must contribute nothing). Both arms run now, on the same machine and graph, at 4k and 8k on the test
// split, and each writes its own results row. The replica is used so the comparison isolates the edges, not HydraDB timing.
//   pnpm tsx bench/scripts/cochange-rows.ts

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildIndex } from '../../packages/core/src/indexer/build.js';
import { OpenAIEmbedder } from '../../packages/core/src/store/embed.js';
import { MemoryStore } from '../../packages/core/src/store/memory.js';
import { DiskCache } from '../../packages/core/src/util/diskCache.js';
import { pushPaths } from '../../packages/click/src/cli/push-state.js';
import { realInProcessRetriever } from '../src/retriever.js';
import { runBenchmark, selectTasks, writeRunArtifacts, type RunnerOptions } from '../src/runner.js';
import { validateTaskDirectory } from '../src/task.js';
import { spawnGit } from './fetch-repo.js';

async function main(): Promise<void> {
  try {
    process.loadEnvFile(resolve('.env'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const benchRoot = resolve('bench');
  const root = resolve('bench/repo');
  const { pinnedSha } = JSON.parse(await readFile(resolve('bench/bench.config.json'), 'utf8')) as { pinnedSha: string };
  const validation = await validateTaskDirectory(benchRoot);
  if (validation.errors.length) throw new Error(validation.errors.join('\n'));
  const exclude = new Set(validation.tasks.flatMap((t) => ((t as { commit?: string }).commit ? [(t as { commit: string }).commit] : [])));
  const plain = await buildIndex(root);
  const withCo = await buildIndex(root, undefined, { coChange: { before: pinnedSha, exclude } });
  const coEdges = withCo.graph.edges.filter((e) => e.kind === 'co_changed').length;
  process.stdout.write(`co_changed edges: ${coEdges} (from history before ${pinnedSha.slice(0, 7)}, ${exclude.size} task commits excluded)\n`);
  const paths = pushPaths(root);
  const store = new MemoryStore(paths.memstore);
  const embedder = new OpenAIEmbedder({ cache: new DiskCache('embed', { dir: paths.cacheDir }) });
  const gitSha = (await spawnGit(['rev-parse', 'HEAD'], resolve('.'))).trim();
  for (const budget of [4_000, 8_000]) {
    for (const [label, index] of [['V3r', plain], ['V3r+cochange', withCo]] as const) {
      const options: RunnerOptions = { variant: label, budget, split: 'test', retriever: 'inproc' };
      const tasks = selectTasks(validation.tasks, options);
      const retriever = await realInProcessRetriever('V3r', { root, graphSnapshot: index.graph, store, embedder, configOverrides: { id: label } });
      const run = await runBenchmark(tasks, retriever, options, { gitSha, latency: 'context' });
      await writeRunArtifacts(benchRoot, run);
      process.stdout.write(`${label} ${budget}: strict=${run.row.metrics.recallStrict.toFixed(4)} run=${run.row.runId}\n`);
    }
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
