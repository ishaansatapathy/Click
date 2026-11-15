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
import type { SymbolLocation } from '../src/metrics.js';
import { runBenchmark, selectTasks, type ResultRow, type RunnerOptions } from '../src/runner.js';
import { validateTaskDirectory } from '../src/task.js';

export interface PackCase {
  name: string;
  strategy: VariantConfig['pack']['strategy'];
  prefix: boolean;
  overrides: DeepPartial<VariantConfig>;
}

export const PACK_CASES: PackCase[] = (['body-signature', 'body-only', 'whole-file'] as const)
  .flatMap((strategy) => [false, true].map((prefix): PackCase => ({
    name: `${strategy}/prefix-${prefix ? 'on' : 'off'}`,
    strategy,
    prefix,
    overrides: { pack: { strategy, prefix } },
  })));

export interface PackResult { case: PackCase; row: ResultRow }

export function selectPackWinner(results: PackResult[]): PackResult {
  if (!results.length) throw new Error('cannot select a pack winner without train results');
  return [...results].sort((a, b) =>
    b.row.metrics.recallStrict - a.row.metrics.recallStrict
    || a.row.metrics.p95ms - b.row.metrics.p95ms
    || a.case.name.localeCompare(b.case.name),
  )[0]!;
}

export function renderPackSweep(v1: ResultRow, results: PackResult[], winner: PackResult): string {
  return [
    '# Prompt 137: pack strategy and prefix ablation',
    '',
    'All selection uses the train split at 4k. Prefix tokens count against the same 4k budget.',
    '',
    '## V1 companion',
    '',
    '| Variant | Strategy | Prefix | n | Strict | Any | Symbol | Precision | p95 ms |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|',
    `| V1 | chunk bodies | off | ${v1.n} | ${pct(v1.metrics.recallStrict)} | ${pct(v1.metrics.recallAny)} | ${pct(v1.metrics.symbolRecall ?? 0)} | ${pct(v1.metrics.precisionTokens)} | ${v1.metrics.p95ms.toFixed(1)} |`,
    '',
    '## V3 ablation',
    '',
    '| Strategy | Prefix | n | Strict | Any | Symbol | Precision | p50 ms | p95 ms | Graph fallback |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...results.map(({ case: c, row }) => `| ${c.strategy} | ${c.prefix ? 'on' : 'off'} | ${row.n} | ${pct(row.metrics.recallStrict)} | ${pct(row.metrics.recallAny)} | ${pct(row.metrics.symbolRecall ?? 0)} | ${pct(row.metrics.precisionTokens)} | ${row.metrics.p50ms.toFixed(1)} | ${row.metrics.p95ms.toFixed(1)} | ${row.degraded['graph-replica'] ?? 0}/${row.n} |`),
    '',
    `Delivery pack defaults selected on train: **strategy=${winner.case.strategy}, prefix=${winner.case.prefix ? 'on' : 'off'}** (strict ${pct(winner.row.metrics.recallStrict)}, p95 ${winner.row.metrics.p95ms.toFixed(1)} ms).`,
    '',
  ].join('\n');
}

const pct = (value: number): string => `${(100 * value).toFixed(2)}%`;

async function main(): Promise<void> {
  const root = resolve('bench/repo');
  try { process.loadEnvFile(resolve('.env')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const validation = await validateTaskDirectory(resolve('bench'));
  if (validation.errors.length) throw new Error(validation.errors.join('\n'));
  const v3Options: RunnerOptions = { variant: 'V3', budget: 4_000, split: 'train', retriever: 'inproc' };
  const v1Options: RunnerOptions = { ...v3Options, variant: 'V1' };
  const train = selectTasks(validation.tasks, v3Options);
  const index = await buildIndex(root);
  const symbolLocations = new Map(index.graph.nodes.flatMap((node): [string, SymbolLocation][] => (
    node.id.startsWith('sym:') && node.path ? [[node.id, { id: node.id, path: node.path, range: node.range }]] : []
  )));
  const paths = pushPaths(root);
  const store = new MemoryStore(paths.memstore);
  const embedder = new OpenAIEmbedder({ cache: new DiskCache('embed', { dir: paths.cacheDir }) });
  await embedder.embed(train.map((task) => task.text), 'query');
  const graph = new HydraDbGraphStore();
  const gitSha = (await spawnGit(['rev-parse', 'HEAD'], resolve('.'))).trim();

  const v1Retriever = await realInProcessRetriever('V1', { root, graphSnapshot: index.graph, store, graph, embedder });
  const metadata = { gitSha, latency: 'context' as const, symbolLocations };
  const v1 = (await runBenchmark(train, v1Retriever, v1Options, metadata)).row;
  process.stdout.write(`V1 companion: strict=${v1.metrics.recallStrict.toFixed(4)}, p95=${v1.metrics.p95ms.toFixed(1)}ms\n`);

  const results: PackResult[] = [];
  for (const packCase of PACK_CASES) {
    const retriever = await realInProcessRetriever('V3', {
      root, graphSnapshot: index.graph, store, graph, embedder, configOverrides: packCase.overrides,
    });
    const row = (await runBenchmark(train, retriever, v3Options, metadata)).row;
    results.push({ case: packCase, row });
    process.stdout.write(`${packCase.name}: strict=${row.metrics.recallStrict.toFixed(4)}, p95=${row.metrics.p95ms.toFixed(1)}ms\n`);
  }
  const winner = selectPackWinner(results);
  await writeFile(resolve('bench/analysis/pack-sweep.json'), `${JSON.stringify({ v: 1, trainN: train.length, v1, results, winner: winner.case }, null, 2)}\n`, 'utf8');
  await writeFile(resolve('bench/analysis/pack-sweep.md'), renderPackSweep(v1, results, winner), 'utf8');
  process.stdout.write(`winner=${winner.case.name}\n`);
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
