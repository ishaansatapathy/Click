import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DeepPartial, VariantConfig } from '../../packages/core/src/config.js';
import { buildIndex } from '../../packages/core/src/indexer/build.js';
import { OpenAIEmbedder } from '../../packages/core/src/store/embed.js';
import { HydraDbGraphStore } from '../../packages/core/src/store/hydradb-graph.js';
import { MemoryStore } from '../../packages/core/src/store/memory.js';
import { DiskCache } from '../../packages/core/src/util/diskCache.js';
import { pushPaths } from '../../packages/click/src/cli/push-state.js';
import { spawnGit } from './fetch-repo.js';
import { realInProcessRetriever } from '../src/retriever.js';
import { runBenchmark, selectTasks, type ResultRow, type RunnerOptions } from '../src/runner.js';
import { validateTaskDirectory } from '../src/task.js';

export interface SweepCase {
  name: string;
  knob: 'default' | 'alpha' | 'seeds' | 'reverseScale' | 'usePriors' | 'symbolWeight';
  value: string;
  overrides: DeepPartial<VariantConfig>;
}

export const SWEEP_CASES: SweepCase[] = [
  { name: 'default', knob: 'default', value: 'alpha=.15 S=8 reverse=1 priors=on symbol=1.5', overrides: {} },
  { name: 'alpha=0.3', knob: 'alpha', value: '0.3', overrides: { expand: { alpha: 0.3 } } },
  { name: 'alpha=0.5', knob: 'alpha', value: '0.5', overrides: { expand: { alpha: 0.5 } } },
  { name: 'seeds=4', knob: 'seeds', value: '4', overrides: { seeds: { count: 4 } } },
  { name: 'seeds=16', knob: 'seeds', value: '16', overrides: { seeds: { count: 16 } } },
  { name: 'reverseScale=0.5', knob: 'reverseScale', value: '0.5', overrides: { expand: { reverseScale: 0.5 } } },
  { name: 'reverseScale=2', knob: 'reverseScale', value: '2', overrides: { expand: { reverseScale: 2 } } },
  { name: 'usePriors=off', knob: 'usePriors', value: 'off', overrides: { expand: { usePriors: false } } },
  { name: 'symbolWeight=1', knob: 'symbolWeight', value: '1', overrides: { seeds: { weights: { symbol: 1 } } } },
  { name: 'symbolWeight=2', knob: 'symbolWeight', value: '2', overrides: { seeds: { weights: { symbol: 2 } } } },
];

export interface SweepResult {
  case: SweepCase;
  row: ResultRow;
}

export function selectWinner(results: SweepResult[]): SweepResult {
  if (!results.length) throw new Error('cannot select a sweep winner without train results');
  return [...results].sort((a, b) =>
    b.row.metrics.recallStrict - a.row.metrics.recallStrict
    || a.row.metrics.p95ms - b.row.metrics.p95ms
    || a.case.name.localeCompare(b.case.name),
  )[0]!;
}

export function renderSweep(results: SweepResult[], winner: SweepResult, test: ResultRow): string {
  const lines = [
    '# Prompt 136: one-knob V3 tuning sweep',
    '',
    'Selection used only the train split at 4k. The test split was evaluated once, after the winner was frozen.',
    '',
    '| Case | Knob | Value | Train strict | Train any | p50 ms | p95 ms | Graph fallback |',
    '|---|---|---|---:|---:|---:|---:|---:|',
    ...results.map(({ case: c, row }) => `| ${c.name} | ${c.knob} | ${c.value} | ${pct(row.metrics.recallStrict)} | ${pct(row.metrics.recallAny)} | ${row.metrics.p50ms.toFixed(1)} | ${row.metrics.p95ms.toFixed(1)} | ${row.degraded['graph-replica'] ?? 0}/${row.n} |`),
    '',
    `Winner: **${winner.case.name}**, train strict ${pct(winner.row.metrics.recallStrict)}.`,
    '',
    '| Frozen evaluation | Strict | Any | Symbol | Precision | p50 ms | p95 ms | Graph fallback |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    `| test, 4k | ${pct(test.metrics.recallStrict)} | ${pct(test.metrics.recallAny)} | ${pct(test.metrics.symbolRecall ?? 0)} | ${pct(test.metrics.precisionTokens)} | ${test.metrics.p50ms.toFixed(1)} | ${test.metrics.p95ms.toFixed(1)} | ${test.degraded['graph-replica'] ?? 0}/${test.n} |`,
    '',
  ];
  return lines.join('\n');
}

const pct = (value: number): string => `${(100 * value).toFixed(2)}%`;

async function main(): Promise<void> {
  const root = resolve('bench/repo');
  try { process.loadEnvFile(resolve('.env')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  const validation = await validateTaskDirectory(resolve('bench'));
  if (validation.errors.length) throw new Error(validation.errors.join('\n'));
  const baseOptions: RunnerOptions = { variant: 'V3', budget: 4_000, split: 'train', retriever: 'inproc' };
  const train = selectTasks(validation.tasks, baseOptions);
  const testOptions: RunnerOptions = { ...baseOptions, split: 'test' };
  const testTasks = selectTasks(validation.tasks, testOptions);
  const index = await buildIndex(root);
  const paths = pushPaths(root);
  const store = new MemoryStore(paths.memstore);
  const embedder = new OpenAIEmbedder({ cache: new DiskCache('embed', { dir: paths.cacheDir }) });
  await embedder.embed(train.map((task) => task.text), 'query');
  const graph = new HydraDbGraphStore();
  const gitSha = (await spawnGit(['rev-parse', 'HEAD'], resolve('.'))).trim();
  const results: SweepResult[] = [];

  for (const sweepCase of SWEEP_CASES) {
    const retriever = await realInProcessRetriever('V3', {
      root, graphSnapshot: index.graph, store, graph, embedder,
      configOverrides: sweepCase.overrides,
    });
    const run = await runBenchmark(train, retriever, baseOptions, { gitSha, latency: 'context' });
    results.push({ case: sweepCase, row: run.row });
    process.stdout.write(`${sweepCase.name}: strict=${run.row.metrics.recallStrict.toFixed(4)}, p95=${run.row.metrics.p95ms.toFixed(1)}ms\n`);
  }

  const winner = selectWinner(results);
  const testRetriever = await realInProcessRetriever('V3', {
    root, graphSnapshot: index.graph, store, graph, embedder,
    configOverrides: winner.case.overrides,
  });
  const test = (await runBenchmark(testTasks, testRetriever, testOptions, { gitSha, latency: 'context' })).row;
  const output = { v: 1, trainN: train.length, testN: testTasks.length, results, winner: winner.case, test };
  await writeFile(resolve('bench/analysis/sweep.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await writeFile(resolve('bench/analysis/sweep.md'), renderSweep(results, winner, test), 'utf8');
  process.stdout.write(`winner=${winner.case.name}; test strict=${test.metrics.recallStrict.toFixed(4)}\n`);
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
