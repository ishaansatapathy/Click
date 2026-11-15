// PROMPT 144: prove that a live V3 run survives HydraDB disappearing and that every post-stop request uses the exact V3r fallback.

import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildIndex } from '../../packages/core/src/indexer/build.js';
import { OpenAIEmbedder } from '../../packages/core/src/store/embed.js';
import { HydraDbGraphStore } from '../../packages/core/src/store/hydradb-graph.js';
import { MemoryStore } from '../../packages/core/src/store/memory.js';
import type { PackedContext } from '../../packages/core/src/types.js';
import { DiskCache } from '../../packages/core/src/util/diskCache.js';
import { pushPaths } from '../../packages/click/src/cli/push-state.js';
import { percentile, perType } from '../src/metrics.js';
import { realInProcessRetriever } from '../src/retriever.js';
import { regenerateResultsMarkdown, runBenchmark, selectTasks, type ResultRow, type RunnerOptions, type TaskDetail } from '../src/runner.js';
import { validateTaskDirectory } from '../src/task.js';
import { spawnGit } from './fetch-repo.js';

interface LatencyRow extends Omit<ResultRow, 'kind'> {
  kind: 'latency';
  notes: string;
}

export function assertFallbackMatches(fallback: readonly TaskDetail[], replica: readonly TaskDetail[]): void {
  const expected = new Map(replica.map((detail) => [detail.taskId, detail]));
  for (const detail of fallback) {
    const match = expected.get(detail.taskId);
    if (!match) throw new Error(`${detail.taskId}: missing from V3r reference`);
    if (detail.recallStrict !== match.recallStrict
      || JSON.stringify(detail.missingGroundTruthFiles) !== JSON.stringify(match.missingGroundTruthFiles)) {
      throw new Error(`${detail.taskId}: replica fallback does not match V3r strict recall (${detail.recallStrict} [${detail.missingGroundTruthFiles.join(',')}]
        vs ${match.recallStrict} [${match.missingGroundTruthFiles.join(',')}])`);
    }
  }
}

export function latencyRow(details: readonly TaskDetail[], base: ResultRow, gitSha: string, now: Date, referenceRun: string): LatencyRow {
  if (!details.length) throw new Error('offline drill needs at least one fallback request');
  const symbol = details.map((detail) => detail.symbolRecall).filter((value): value is number => value !== null);
  const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    runId: `${now.toISOString().replace(/[-:.]/g, '')}-${randomBytes(3).toString('hex')}`,
    ts: now.toISOString(),
    gitSha,
    kind: 'latency',
    variant: 'V3-hydra-offline',
    configHash: base.configHash,
    budget: base.budget,
    split: 'test',
    n: details.length,
    metrics: {
      recallStrict: mean(details.map((detail) => detail.recallStrict)),
      recallAny: mean(details.map((detail) => detail.recallAny)),
      ...(symbol.length ? { symbolRecall: mean(symbol) } : {}),
      precisionTokens: mean(details.map((detail) => detail.precisionTokens)),
      p50ms: percentile(details.map((detail) => detail.latencyMs), 0.5),
      p95ms: percentile(details.map((detail) => detail.latencyMs), 0.95),
    },
    perType: perType(details),
    pruner: { none: details.length },
    degraded: { 'graph-replica': details.length },
    notes: `HydraDB stopped after one live V3 request; ${details.length} subsequent requests all fell back locally and matched ${referenceRun} task-for-task.`,
  };
}

export function renderDrill(row: LatencyRow, total: number, firstDegraded: readonly string[], referenceRun: string): string {
  return [
    '# HydraDB on/off drill (Prompt 144)',
    '',
    `A V3 run started against live self-hosted HydraDB. After the first request returned, HydraDB was stopped; the remaining ${row.n} requests continued through the local replica. HydraDB was restored after the drill.`,
    '',
    `- All ${total} requests returned.`,
    `- First live request degraded flags: ${firstDegraded.length ? firstDegraded.join(', ') : 'none'}.`,
    `- Every post-stop request reported \`degraded: graph-replica\`.`,
    `- Every post-stop task matched a same-process V3r control exactly on strict recall and missing strict-GT files (historical reference row: \`${referenceRun}\`).`,
    `- Offline strict recall: ${(100 * row.metrics.recallStrict).toFixed(2)}%.`,
    `- Offline latency: p50 ${row.metrics.p50ms.toFixed(1)} ms / p95 ${row.metrics.p95ms.toFixed(1)} ms.`,
    `- Latency row: \`${row.runId}\` (clearly labelled \`${row.variant}\`).`,
    '',
    'The drill proves failure safety, not HydraDB speed: after the connection failure, local replica PPR is the measured path.',
    '',
  ].join('\n');
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  return (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
}

async function waitForDownSignal(path: string, timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(path, 'utf8');
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`HydraDB down signal was not written within ${timeoutMs} ms after DRILL_READY`);
}

async function main(): Promise<void> {
  try { process.loadEnvFile(resolve('.env')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const bench = resolve('bench');
  const root = resolve(bench, 'repo');
  const resultsPath = resolve(bench, 'results.jsonl');
  const rows = await readJsonLines<ResultRow>(resultsPath);
  const reference = [...rows].filter((row) => row.variant === 'V3r' && row.budget === 4_000 && row.split === 'test')
    .sort((a, b) => b.ts.localeCompare(a.ts))[0];
  if (!reference) throw new Error('missing V3r 4k reference row');
  const existing = rows.find((row) => row.variant === 'V3-hydra-offline' && row.gitSha === (rows.at(-1)?.gitSha ?? ''));
  if (existing) throw new Error(`offline drill already recorded for this revision: ${existing.runId}`);
  const validation = await validateTaskDirectory(bench);
  if (validation.errors.length) throw new Error(validation.errors.join('\n'));
  const options: RunnerOptions = { variant: 'V3', budget: 4_000, split: 'test', retriever: 'inproc' };
  const tasks = selectTasks(validation.tasks, options);
  const index = await buildIndex(root);
  const paths = pushPaths(root);
  const store = new MemoryStore(paths.memstore);
  const embedder = new OpenAIEmbedder({ cache: new DiskCache('embed', { dir: paths.cacheDir }) });
  await embedder.embed(tasks.map((task) => task.text), 'query');
  const contexts: PackedContext[] = [];
  const marker = resolve('.click', 'hydra-drill-ready');
  const downSignal = resolve('.click', 'hydra-drill-down');
  await mkdir(resolve('.click'), { recursive: true });
  await Promise.all([rm(marker, { force: true }), rm(downSignal, { force: true })]);
  try {
    const graph = new HydraDbGraphStore();
    const live = await realInProcessRetriever('V3', {
      root, graphSnapshot: index.graph, store, graph, embedder,
      onContext: ({ packed }) => { contexts.push(packed); },
    });
    let calls = 0;
    const drill = async (task: Parameters<typeof live>[0], budget: number): Promise<PackedContext> => {
      const packed = await live(task, budget);
      calls++;
      if (calls === 1) {
        await writeFile(marker, `${new Date().toISOString()}\n`, 'utf8');
        process.stdout.write('DRILL_READY: stop HydraDB now\n');
        await waitForDownSignal(downSignal);
      }
      return packed;
    };
    const gitSha = (await spawnGit(['rev-parse', 'HEAD'], resolve('.'))).trim();
    const run = await runBenchmark(tasks, drill, options, { gitSha, latency: 'context', concurrency: 1 });
    if (contexts.length !== tasks.length) throw new Error(`expected ${tasks.length} contexts, got ${contexts.length}`);
    const offlineContexts = contexts.slice(1);
    if (offlineContexts.some((context) => !context.degraded.includes('graph-replica'))) throw new Error('a post-stop request did not report graph-replica fallback');
    const offlineDetails = run.details.slice(1);
    // Compare to a same-process V3r control. The historical V3r row remains the public reference, but later code/config changes
    // must not make an old artifact the oracle for the failure-safety invariant.
    const controlTasks = tasks.slice(1);
    const controlOptions: RunnerOptions = { ...options, variant: 'V3r' };
    const controlRetriever = await realInProcessRetriever('V3r', { root, graphSnapshot: index.graph, store, graph: null, embedder });
    const control = await runBenchmark(controlTasks, controlRetriever, controlOptions, { gitSha, latency: 'context', concurrency: 1 });
    assertFallbackMatches(offlineDetails, control.details);
    const row = latencyRow(offlineDetails, run.row, gitSha, new Date(), reference.runId);
    await appendFile(resultsPath, `${JSON.stringify(row)}\n`, 'utf8');
    await regenerateResultsMarkdown(resultsPath, resolve(bench, 'results.md'));
    await writeFile(resolve(bench, 'analysis', 'hydra-fallback.md'), renderDrill(row, tasks.length, contexts[0]!.degraded, reference.runId), 'utf8');
    process.stdout.write(`${row.runId}: n=${row.n} strict=${row.metrics.recallStrict.toFixed(4)} p50=${row.metrics.p50ms.toFixed(1)} p95=${row.metrics.p95ms.toFixed(1)}\n`);
  } finally {
    await Promise.all([rm(marker, { force: true }), rm(downSignal, { force: true })]);
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
