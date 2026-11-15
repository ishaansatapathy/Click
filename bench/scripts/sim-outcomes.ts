// PROMPT 159: simulated training outcomes for the learning benchmark.
// These are deliberately written under bench/data/bench-sim-* and never into bench/repo/.click, so synthetic evidence cannot
// contaminate a developer's real continual-learning history. V5 below is V3 with expand.useLearned=true.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ContextRecord, OutcomeEvent } from '../../packages/core/src/contracts.js';
import { buildIndex } from '../../packages/core/src/indexer/build.js';
import { deriveWeights } from '../../packages/core/src/learn/derive.js';
import { WeightSync } from '../../packages/core/src/learn/weights.js';
import { OpenAIEmbedder } from '../../packages/core/src/store/embed.js';
import { HydraDbGraphStore } from '../../packages/core/src/store/hydradb-graph.js';
import { MemoryStore } from '../../packages/core/src/store/memory.js';
import type { GraphNode, WeightsDoc } from '../../packages/core/src/types.js';
import { DiskCache } from '../../packages/core/src/util/diskCache.js';
import { pushPaths } from '../../packages/click/src/cli/push-state.js';
import { realInProcessRetriever } from '../src/retriever.js';
import { runBenchmark, selectTasks, writeRunArtifacts, type ResultRow, type RunnerOptions, type TaskDetail } from '../src/runner.js';
import { validateTaskDirectory, type BenchTask } from '../src/task.js';
import { spawnGit } from './fetch-repo.js';

export const SIM_CONTEXTS = resolve('bench/data/bench-sim-contexts.jsonl');
export const SIM_OUTCOMES = resolve('bench/data/bench-sim-outcomes.jsonl');
export const SIM_WEIGHTS = resolve('bench/data/bench-sim-weights.json');
export const UNDATED_TRAIN_TS = '9999-12-31T23:59:59.999Z';

export function temporalTrain(tasks: readonly BenchTask[]): BenchTask[] {
  return tasks.filter((task) => task.split === 'train').sort((a, b) =>
    (a.date ?? UNDATED_TRAIN_TS).localeCompare(b.date ?? UNDATED_TRAIN_TS) || a.id.localeCompare(b.id),
  );
}

export function groundTruthSymbolNames(task: BenchTask, nodes: ReadonlyMap<string, GraphNode>): string[] {
  return [...new Set(task.groundTruth.symbols.map((id) => {
    const node = nodes.get(id);
    if (!node) throw new Error(`${task.id}: ground-truth symbol is not indexed: ${id}`);
    return node.name;
  }))].sort();
}

export function simulatedRecord(record: ContextRecord, task: BenchTask): ContextRecord {
  const ts = task.date ?? UNDATED_TRAIN_TS;
  return { ...record, contextId: `ctx_bench_sim_${task.id.replace(/[^a-z0-9]/gi, '_')}`, ts, source: 'bench-sim' };
}

export function simulatedOutcome(task: BenchTask, record: ContextRecord, nodes: ReadonlyMap<string, GraphNode>): OutcomeEvent {
  const filesRead = [...new Set(record.items.flatMap(({ nodeId }) => {
    const path = nodes.get(nodeId)?.path;
    return path ? [path] : [];
  }))].sort();
  return {
    v: 1,
    type: 'outcome',
    id: `evt_bench_sim_${task.id.replace(/[^a-z0-9]/gi, '_')}`,
    ts: task.date ?? UNDATED_TRAIN_TS,
    source: 'bench-sim',
    contextIds: [record.contextId],
    taskText: task.text,
    filesRead,
    filesEdited: [...task.groundTruth.files].sort(),
    diffSymbols: groundTruthSymbolNames(task, nodes),
    check: { kind: 'none', passed: true },
    repoCommit: record.repoCommit,
  };
}

export function jsonLines(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join('\n') + (values.length ? '\n' : '');
}

export interface PairedCi { delta: number; lo: number; hi: number }

export function pairedBootstrap(a: readonly TaskDetail[], b: readonly TaskDetail[], samples = 10_000): PairedCi {
  const left = new Map(a.map((row) => [row.taskId, row.recallStrict]));
  const deltas = b.map((row) => {
    const before = left.get(row.taskId);
    if (before === undefined) throw new Error(`unpaired task: ${row.taskId}`);
    return row.recallStrict - before;
  });
  if (deltas.length !== a.length || deltas.length === 0) throw new Error('paired bootstrap requires the same non-empty task set');
  const random = mulberry32(159);
  const draws: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    let total = 0;
    for (let i = 0; i < deltas.length; i++) total += deltas[Math.floor(random() * deltas.length)]!;
    draws.push(total / deltas.length);
  }
  draws.sort((x, y) => x - y);
  const at = (p: number): number => draws[Math.floor((draws.length - 1) * p)]!;
  return { delta: deltas.reduce((sum, value) => sum + value, 0) / deltas.length, lo: at(0.025), hi: at(0.975) };
}

export function renderV5(rows: readonly ResultRow[], references: readonly ResultRow[], cis: readonly PairedCi[], weights: WeightsDoc, events: number): string {
  const pct = (n: number): string => `${(100 * n).toFixed(2)}%`;
  const ref = (variant: string, budget: number): ResultRow => {
    const row = references.find((candidate) => candidate.variant === variant && candidate.budget === budget);
    if (!row) throw new Error(`missing ${variant} ${budget} reference row`);
    return row;
  };
  return [
    '# V5 learned-weight rows (simulated evidence)',
    '',
    `V5 is V3 with \`expand.useLearned=true\`. Weights version \`${weights.version}\` was derived only from ${events} temporally ordered train outcomes labelled \`source: bench-sim\`; no test outcome was used.`,
    '',
    '| Variant | Run | Budget | n | Strict | Any | Symbol | Precision | p50 ms | p95 ms |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.flatMap((row) => ['V1', 'V3'].map((variant) => ref(variant, row.budget)).concat(row).map((candidate) => `| ${candidate.variant} | \`${candidate.runId}\` | ${candidate.budget} | ${candidate.n} | ${pct(candidate.metrics.recallStrict)} | ${pct(candidate.metrics.recallAny)} | ${pct(candidate.metrics.symbolRecall ?? 0)} | ${pct(candidate.metrics.precisionTokens)} | ${candidate.metrics.p50ms.toFixed(1)} | ${candidate.metrics.p95ms.toFixed(1)} |`)),
    '',
    '## Paired bootstrap (V5 − V3 strict recall, 10k draws)',
    '',
    '| Budget | Delta | 95% CI |',
    '|---:|---:|---:|',
    ...rows.map((row, index) => `| ${row.budget} | ${pct(cis[index]!.delta)} | [${pct(cis[index]!.lo)}, ${pct(cis[index]!.hi)}] |`),
    '',
    'These are simulated-learning retrieval rows, not real-agent outcomes.',
    '',
  ].join('\n');
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

async function main(): Promise<void> {
  try { process.loadEnvFile(resolve('.env')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  const benchRoot = resolve('bench');
  const root = resolve('bench/repo');
  const validation = await validateTaskDirectory(benchRoot);
  if (validation.errors.length) throw new Error(validation.errors.join('\n'));
  const train = temporalTrain(validation.tasks);
  const testOptions = (budget: number): RunnerOptions => ({ variant: 'V5', budget, split: 'test', retriever: 'inproc' });
  const test = selectTasks(validation.tasks, testOptions(4_000));
  const index = await buildIndex(root);
  const nodes = new Map(index.graph.nodes.map((node) => [node.id, node]));
  const paths = pushPaths(root);
  const store = new MemoryStore(paths.memstore);
  const embedder = new OpenAIEmbedder({ cache: new DiskCache('embed', { dir: paths.cacheDir }) });
  await embedder.embed([...train, ...test].map((task) => task.text), 'query');
  const graph = new HydraDbGraphStore();
  const captured: ContextRecord[] = [];
  const winner = await realInProcessRetriever('V3', {
    root, graphSnapshot: index.graph, store, graph, embedder, source: 'bench-sim',
    onContext: ({ record }) => { captured.push(record); },
  });

  const contexts: ContextRecord[] = [];
  const outcomes: OutcomeEvent[] = [];
  for (const task of train) {
    const before = captured.length;
    await winner(task, 4_000);
    const record = captured[before];
    if (!record || captured.length !== before + 1) throw new Error(`${task.id}: winner did not emit exactly one context record`);
    const simulated = simulatedRecord(record, task);
    contexts.push(simulated);
    outcomes.push(simulatedOutcome(task, simulated, nodes));
  }
  await Promise.all([
    writeFile(SIM_CONTEXTS, jsonLines(contexts), 'utf8'),
    writeFile(SIM_OUTCOMES, jsonLines(outcomes), 'utf8'),
  ]);

  const weights = deriveWeights(outcomes, contexts, index.graph);
  await Promise.all([
    store.putWeights(weights),
    writeFile(SIM_WEIGHTS, `${JSON.stringify({ ...weights, simulated: true, source: 'bench-sim' }, null, 2)}\n`, 'utf8'),
  ]);
  const sync = new WeightSync(graph, { retryMs: [1_000, 2_000, 5_000] });
  sync.push(weights);
  await sync.idle();
  sync.close();
  if (sync.stats.failures > 0) throw new Error(`failed to push learned weights to HydraDB (${sync.stats.failures} failure(s))`);

  const gitSha = (await spawnGit(['rev-parse', 'HEAD'], resolve('.'))).trim();
  const rows: ResultRow[] = [];
  for (const budget of [4_000, 8_000]) {
    const options = testOptions(budget);
    const retriever = await realInProcessRetriever('V3', {
      root, graphSnapshot: index.graph, store, graph, embedder,
      configOverrides: { id: 'V5', expand: { useLearned: true } },
    });
    const run = await runBenchmark(test, retriever, options, { gitSha, latency: 'context' });
    await writeRunArtifacts(benchRoot, run);
    rows.push(run.row);
    process.stdout.write(`V5 ${budget}: ${run.row.runId} strict=${run.row.metrics.recallStrict.toFixed(4)} symbol=${(run.row.metrics.symbolRecall ?? 0).toFixed(4)}\n`);
  }
  const resultRows = (await readFile(resolve(benchRoot, 'results.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ResultRow);
  const references = ['V1', 'V3'].flatMap((variant) => [4_000, 8_000].map((budget) => [...resultRows]
    .filter((row) => row.variant === variant && row.budget === budget && row.split === 'test')
    .sort((a, b) => b.ts.localeCompare(a.ts))[0] ?? (() => { throw new Error(`missing ${variant} ${budget} reference row`); })()));
  const cis: PairedCi[] = [];
  for (const row of rows) {
    const baseline = references.find((candidate) => candidate.variant === 'V3' && candidate.budget === row.budget)!;
    const readDetails = async (runId: string): Promise<TaskDetail[]> => (await readFile(resolve(benchRoot, 'runs', `${runId}.jsonl`), 'utf8'))
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as TaskDetail);
    cis.push(pairedBootstrap(await readDetails(baseline.runId), await readDetails(row.runId)));
  }
  await writeFile(resolve('bench/analysis/v5-learned.md'), renderV5(rows, references, cis, weights, outcomes.length), 'utf8');
  process.stdout.write(`simulated=${outcomes.length}; weights=${weights.version}; changed=${Object.keys(weights.multipliers).length}; added=${weights.addedEdges.length}\n`);
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
