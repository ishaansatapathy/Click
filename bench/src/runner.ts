import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { PackedContext } from '../../packages/core/src/types.js';
import { buildIndex } from '../../packages/core/src/indexer/build.js';
import { parseId } from '../../packages/core/src/util/ids.js';
import { loadBenchConfig, spawnGit } from '../scripts/fetch-repo.js';
import { emptyRetriever, gitBaselineRepo, memoizeBaselineRepo, oracleRetriever, randomRetriever } from './dummy-retrievers.js';
import { perType, percentile, precisionTokens, recallAny, recallStrict, symbolRecall, type SymbolLocation } from './metrics.js';
import { httpRetriever, inProcessRetriever, type Retriever } from './retriever.js';
import { loadRejected, loadTaskValues, validateTasks, type BenchTask } from './task.js';

export type BenchSplit = 'train' | 'test' | 'all' | 'e2e';
export type RetrieverKind = 'inproc' | 'http' | 'empty' | 'random' | 'oracle';

export interface RunnerOptions {
  variant: string;
  budget: number;
  split: BenchSplit;
  types?: BenchTask['type'][];
  limit?: number;
  retriever: RetrieverKind;
}

export interface TaskDetail {
  taskId: string;
  type: BenchTask['type'];
  recallStrict: number;
  recallAny: number;
  symbolRecall: number | null;
  precisionTokens: number;
  latencyMs: number;
  groundTruthFiles: string[];
  missingGroundTruthFiles: string[];
  items: Array<PackedContext['items'][number] & { reasons: string[] }>;
}

export interface ResultRow {
  runId: string;
  ts: string;
  gitSha: string;
  kind: 'retrieval';
  variant: string;
  configHash: string;
  budget: number;
  split: BenchSplit;
  n: number;
  metrics: {
    recallStrict: number;
    recallAny: number;
    symbolRecall?: number;
    precisionTokens: number;
    p50ms: number;
    p95ms: number;
  };
  perType: Record<string, { n: number; recallStrict: number }>;
  pruner: Record<string, number>;
  degraded: Record<string, number>;
}

export interface BenchmarkRun {
  row: ResultRow;
  details: TaskDetail[];
}

interface RunMetadata {
  gitSha: string;
  now?: Date;
  concurrency?: number;
  latency?: 'context' | 'wall';
  symbolLocations?: ReadonlyMap<string, SymbolLocation>;
}

export function parseRunnerArgs(args: readonly string[]): RunnerOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(`Expected --flag value, got: ${flag ?? '<end>'}`);
    values.set(flag.slice(2), value);
  }
  const allowed = new Set(['variant', 'budget', 'split', 'types', 'limit', 'retriever']);
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error(`Unknown option: --${key}`);
  const variant = required(values, 'variant');
  const budget = positiveInteger(required(values, 'budget'), 'budget');
  const split = required(values, 'split');
  if (!['train', 'test', 'all', 'e2e'].includes(split)) throw new Error(`Invalid split: ${split}`);
  const retriever = values.get('retriever') ?? 'inproc';
  if (!['inproc', 'http', 'empty', 'random', 'oracle'].includes(retriever)) throw new Error(`Invalid retriever: ${retriever}`);
  const types = values.get('types')?.split(',').filter(Boolean) as BenchTask['type'][] | undefined;
  const validTypes = new Set(['single-file', 'multi-file', 'multi-hop', 'impact', 'convention']);
  if (types?.some((type) => !validTypes.has(type))) throw new Error(`Invalid task type list: ${values.get('types')}`);
  const limit = values.has('limit') ? positiveInteger(values.get('limit')!, 'limit') : undefined;
  return { variant, budget, split: split as BenchSplit, types, limit, retriever: retriever as RetrieverKind };
}

export function selectTasks(tasks: BenchTask[], options: RunnerOptions): BenchTask[] {
  const selected = tasks.filter((task) => {
    const splitMatches = options.split === 'all' || (options.split === 'e2e' ? task.e2e : task.split === options.split);
    return splitMatches && (!options.types || options.types.includes(task.type));
  });
  return options.limit === undefined ? selected : selected.slice(0, options.limit);
}

export async function runBenchmark(
  tasks: BenchTask[],
  retriever: Retriever,
  options: RunnerOptions,
  metadata: RunMetadata,
): Promise<BenchmarkRun> {
  if (tasks.length === 0) throw new Error('No benchmark tasks matched the requested filters');
  const contexts = new Array<PackedContext>(tasks.length);
  const details = await mapLimit(tasks, metadata.concurrency ?? 4, async (task, index) => {
    const started = performance.now();
    const context = await retriever(task, options.budget);
    const wallMs = performance.now() - started;
    contexts[index] = context;
    const symbols = symbolLocations(task.groundTruth.symbols, metadata.symbolLocations);
    const strict = recallStrict(task, context);
    const retrieved = new Set(context.items.filter((item) => item.path !== null && (item.mode === 'body' || item.mode === 'file')).map((item) => item.path!));
    return {
      taskId: task.id,
      type: task.type,
      recallStrict: strict,
      recallAny: recallAny(task, context),
      symbolRecall: symbolRecall(task, context, symbols),
      precisionTokens: precisionTokens(task, context),
      latencyMs: metadata.latency === 'wall' ? wallMs : (context.timings.total ?? wallMs),
      groundTruthFiles: task.groundTruth.files,
      missingGroundTruthFiles: task.groundTruth.files.filter((path) => !retrieved.has(path)),
      items: context.items.map((item) => ({
        ...item,
        reasons: (item as PackedContext['items'][number] & { reasons?: string[] }).reasons ?? [],
      })),
    } satisfies TaskDetail;
  });
  const symbolValues = details.map((detail) => detail.symbolRecall).filter((value): value is number => value !== null);
  const firstContext = contexts[0]!;
  const now = metadata.now ?? new Date();
  const row: ResultRow = {
    runId: runId(now),
    ts: now.toISOString(),
    gitSha: metadata.gitSha,
    kind: 'retrieval',
    variant: options.variant,
    configHash: firstContext.configHash,
    budget: options.budget,
    split: options.split,
    n: tasks.length,
    metrics: {
      recallStrict: mean(details.map((detail) => detail.recallStrict)),
      recallAny: mean(details.map((detail) => detail.recallAny)),
      ...(symbolValues.length ? { symbolRecall: mean(symbolValues) } : {}),
      precisionTokens: mean(details.map((detail) => detail.precisionTokens)),
      p50ms: percentile(details.map((detail) => detail.latencyMs), 0.5),
      p95ms: percentile(details.map((detail) => detail.latencyMs), 0.95),
    },
    perType: perType(details),
    pruner: counts(contexts.map((context) => context.pruner)),
    degraded: counts(contexts.flatMap((context) => context.degraded)),
  };
  return { row, details };
}

export async function writeRunArtifacts(benchRoot: string, run: BenchmarkRun): Promise<void> {
  const runsDir = resolve(benchRoot, 'runs');
  await mkdir(runsDir, { recursive: true });
  await writeFile(resolve(runsDir, `${run.row.runId}.jsonl`), run.details.map((detail) => JSON.stringify(detail)).join('\n') + '\n', 'utf8');
  const resultsPath = resolve(benchRoot, 'results.jsonl');
  await appendFile(resultsPath, `${JSON.stringify(run.row)}\n`, 'utf8');
  await regenerateResultsMarkdown(resultsPath, resolve(benchRoot, 'results.md'));
}

export async function regenerateResultsMarkdown(resultsPath: string, markdownPath: string): Promise<void> {
  const rows = (await readFile(resultsPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ResultRow);
  const header = '# Benchmark results\n\nGenerated from `results.jsonl`; do not edit by hand.\n\n';
  const table = [
    '| Run | Variant | Budget | Split | n | Strict | Any | Symbol | Precision | p50 ms | p95 ms |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) => `| ${row.runId} | ${row.variant} | ${row.budget} | ${row.split} | ${row.n} | ${format(row.metrics.recallStrict)} | ${format(row.metrics.recallAny)} | ${row.metrics.symbolRecall === undefined ? '—' : format(row.metrics.symbolRecall)} | ${format(row.metrics.precisionTokens)} | ${row.metrics.p50ms.toFixed(1)} | ${row.metrics.p95ms.toFixed(1)} |`),
  ].join('\n');
  await writeFile(markdownPath, `${header}${table}\n`, 'utf8');
}

function symbolLocations(ids: string[], atH?: ReadonlyMap<string, SymbolLocation>): Map<string, SymbolLocation> {
  const result = new Map<string, SymbolLocation>();
  for (const id of ids) {
    const indexed = atH?.get(id);
    if (indexed) {
      result.set(id, indexed);
      continue;
    }
    const parsed = parseId(id);
    if (parsed?.kind === 'sym') result.set(id, { id, path: parsed.path });
  }
  return result;
}

async function mapLimit<T, U>(items: T[], limit: number, task: (item: T, index: number) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
const counts = (values: string[]): Record<string, number> => values.reduce<Record<string, number>>((result, value) => {
  result[value] = (result[value] ?? 0) + 1;
  return result;
}, {});
const format = (value: number): string => value.toFixed(3);
const runId = (date: Date): string => `${date.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z')}-${randomBytes(3).toString('hex')}`;
const required = (values: Map<string, string>, key: string): string => {
  const value = values.get(key);
  if (!value) throw new Error(`Missing required option: --${key}`);
  return value;
};
const positiveInteger = (value: string, name: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
  return parsed;
};

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const options = parseRunnerArgs(process.argv.slice(2));
  const config = loadBenchConfig(resolve(benchDir, 'bench.config.json'));
  const repo = resolve(benchDir, 'repo');
  const files = new Set((await spawnGit(['ls-tree', '-r', '--name-only', config.pinnedSha], repo)).split(/\r?\n/).filter(Boolean));
  const index = await buildIndex(repo);
  const nodeIds = new Set(index.graph.nodes.map((node) => node.id));
  const symbolsAtH = new Map(index.graph.nodes.flatMap((node): [string, SymbolLocation][] => (
    node.id.startsWith('sym:') && node.path ? [[node.id, { id: node.id, path: node.path, range: node.range }]] : []
  )));
  const validation = validateTasks(
    await loadTaskValues(resolve(benchDir, 'tasks')),
    files,
    nodeIds,
    await loadRejected(resolve(benchDir, 'tasks', 'rejected.txt')),
  );
  if (validation.errors.length) throw new Error(`Task validation failed:\n${validation.errors.join('\n')}`);
  const tasks = selectTasks(validation.tasks, options);
  const baseline = memoizeBaselineRepo(gitBaselineRepo(repo, config.pinnedSha));
  const retriever = options.retriever === 'empty' ? emptyRetriever()
    : options.retriever === 'random' ? randomRetriever(baseline)
      : options.retriever === 'oracle' ? oracleRetriever(baseline)
        : options.retriever === 'http' && process.env.CLICK_DAEMON_URL
          ? httpRetriever({ baseUrl: process.env.CLICK_DAEMON_URL, variant: options.variant, token: process.env.CLICK_DAEMON_TOKEN })
          : options.retriever === 'http' ? httpRetriever() : inProcessRetriever(options.variant);
  const gitSha = (await spawnGit(['rev-parse', 'HEAD'], resolve(benchDir, '..'))).trim();
  const run = await runBenchmark(tasks, retriever, options, {
    gitSha,
    latency: options.retriever === 'http' ? 'wall' : 'context',
    symbolLocations: symbolsAtH,
  });
  await writeRunArtifacts(benchDir, run);
  process.stdout.write(`Completed ${run.row.runId}: n=${run.row.n}, strict=${run.row.metrics.recallStrict.toFixed(3)}\n`);
}
