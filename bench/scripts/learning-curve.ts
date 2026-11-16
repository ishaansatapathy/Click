// PROMPTS 160: the learning curve. Weights are derived from the first 0 / 25 / 50 / 75 / 100% of the simulated train events
// (bench/data/bench-sim-*.jsonl, written by sim-outcomes.ts), pushed to HydraDB and the local store, and V5 is evaluated on the
// TEST split at 4k tokens after each step. Writes `learning` rows (one per step) to results.jsonl via the runner, and
// bench/data/learning.json for the chart. Never tunes anything on test.
//   pnpm tsx bench/scripts/learning-curve.ts

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildIndex } from '../../packages/core/src/indexer/build.js';
import { deriveWeights } from '../../packages/core/src/learn/derive.js';
import { WeightSync } from '../../packages/core/src/learn/weights.js';
import { OpenAIEmbedder } from '../../packages/core/src/store/embed.js';
import { HydraDbGraphStore } from '../../packages/core/src/store/hydradb-graph.js';
import { MemoryStore } from '../../packages/core/src/store/memory.js';
import { DiskCache } from '../../packages/core/src/util/diskCache.js';
import type { ContextRecord, OutcomeEvent } from '../../packages/core/src/contracts.js';
import { pushPaths } from '../../packages/click/src/cli/push-state.js';
import { realInProcessRetriever } from '../src/retriever.js';
import { runBenchmark, selectTasks, writeRunArtifacts, type RunnerOptions } from '../src/runner.js';
import { validateTaskDirectory } from '../src/task.js';
import { spawnGit } from './fetch-repo.js';
import { SIM_CONTEXTS, SIM_OUTCOMES } from './sim-outcomes.js';

export const FRACTIONS = [0, 0.25, 0.5, 0.75, 1] as const;

const readJsonl = async <T>(file: string): Promise<T[]> =>
  (await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as T);

/** The events a step learns from: the first `fraction` of the log, in log order (the order they happened). */
export const prefixOf = <T>(events: readonly T[], fraction: number): T[] => events.slice(0, Math.round(events.length * fraction));

async function main(): Promise<void> {
  try {
    process.loadEnvFile(resolve('.env'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const benchRoot = resolve('bench');
  const root = resolve('bench/repo');
  const validation = await validateTaskDirectory(benchRoot);
  if (validation.errors.length) throw new Error(validation.errors.join('\n'));
  const options: RunnerOptions = { variant: 'V5', budget: 4_000, split: 'test', retriever: 'inproc' };
  const test = selectTasks(validation.tasks, options);
  const index = await buildIndex(root);
  const contexts = await readJsonl<ContextRecord>(SIM_CONTEXTS);
  const outcomes = await readJsonl<OutcomeEvent>(SIM_OUTCOMES);
  const paths = pushPaths(root);
  const store = new MemoryStore(paths.memstore);
  const embedder = new OpenAIEmbedder({ cache: new DiskCache('embed', { dir: paths.cacheDir }) });
  const graph = new HydraDbGraphStore();
  const gitSha = (await spawnGit(['rev-parse', 'HEAD'], resolve('.'))).trim();

  const steps: { fraction: number; events: number; weightsVersion: string; runId: string; strict: number; symbol: number | null }[] = [];
  for (const fraction of FRACTIONS) {
    const used = prefixOf(outcomes, fraction);
    const weights = deriveWeights(used, contexts, index.graph);
    await store.putWeights(weights);
    const sync = new WeightSync(graph, { retryMs: [1_000, 2_000, 5_000], graphVersion: () => index.graph.version });
    sync.push(weights);
    await sync.idle();
    sync.close();
    if (sync.stats.failures > 0) throw new Error(`step ${fraction}: pushing weights to HydraDB failed`);
    const retriever = await realInProcessRetriever('V3', {
      root, graphSnapshot: index.graph, store, graph, embedder,
      configOverrides: { id: `V5@${Math.round(fraction * 100)}%`, expand: { useLearned: true } },
    });
    const run = await runBenchmark(test, retriever, options, { gitSha, latency: 'context' });
    await writeRunArtifacts(benchRoot, run);
    steps.push({ fraction, events: used.length, weightsVersion: weights.version, runId: run.row.runId, strict: run.row.metrics.recallStrict, symbol: run.row.metrics.symbolRecall ?? null });
    process.stdout.write(`${Math.round(fraction * 100)}% (${used.length} events): strict=${run.row.metrics.recallStrict.toFixed(4)} run=${run.row.runId}\n`);
  }
  await writeFile(resolve('bench/data/learning.json'), `${JSON.stringify({ simulated: true, split: 'test', budget: 4_000, n: test.length, steps }, null, 2)}\n`, 'utf8');
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
