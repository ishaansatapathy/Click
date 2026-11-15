// Seat B's A/B runner for the 133 -> 134 loop: the benchmark's own retriever and runner, one variant, several named config overrides,
// the same tasks, side by side. Nothing is written to bench/results.jsonl (that file belongs to Seat A); rows are printed and saved
// as JSON under the path in AB_OUT so the verdict can cite their run ids.
//
//   pnpm exec tsx packages/core/test/experiments/ab.ts --variant V3 --split train --budgets 4000,8000 --cases base,reserve0
//
// Cases are defined in CASES below. The HydraDB token and the OpenAI key (only needed for query embeddings that are not cached yet)
// are read from the environment / Seat A's .env; neither is printed.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { DeepPartial, VariantConfig } from '../../src/config.js';
import { buildIndex } from '../../src/indexer/build.js';
import { loadBenchConfig, spawnGit } from '../../../../bench/scripts/fetch-repo.js';
import { realInProcessRetriever } from '../../../../bench/src/retriever.js';
import { runBenchmark, selectTasks, type BenchSplit, type ResultRow } from '../../../../bench/src/runner.js';
import type { SymbolLocation } from '../../../../bench/src/metrics.js';
import { loadRejected, loadTaskValues, validateTasks } from '../../../../bench/src/task.js';

export const CASES: Record<string, DeepPartial<VariantConfig>> = {
  base: {},
  reserve0: { seeds: { reserve: 0 } },
  reserve3: { seeds: { reserve: 3 } },
  body400: { pack: { maxBodyTokens: 400 } },
  body700: { pack: { maxBodyTokens: 700 } },
  slice: { pack: { sliceLarge: true } },
  slice600: { pack: { sliceLarge: true, maxBodyTokens: 600 } },
  cand20: { candidates: 20 },
  cand80: { candidates: 80 },
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const benchDir = resolve(repoRoot, 'bench');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main(): Promise<void> {
  for (const f of [resolve(repoRoot, '..', 'a', '.env'), resolve(repoRoot, '.env')]) {
    try {
      process.loadEnvFile(f);
    } catch {
      // not there
    }
  }
  process.env.HYDRADB_TOKEN_FILE ??= resolve(homedir(), '.click', 'hydradb-token');

  const variant = arg('variant', 'V3');
  const split = arg('split', 'train') as BenchSplit;
  const budgets = arg('budgets', '4000').split(',').map(Number);
  const names = arg('cases', 'base').split(',');
  const out = arg('out', process.env.AB_OUT ?? resolve(repoRoot, 'docs', `ab-${variant}-${split}.json`));

  const config = loadBenchConfig(resolve(benchDir, 'bench.config.json'));
  const repo = resolve(benchDir, 'repo');
  const files = new Set((await spawnGit(['ls-tree', '-r', '--name-only', config.pinnedSha], repo)).split(/\r?\n/).filter(Boolean));
  const index = await buildIndex(repo);
  const nodeIds = new Set(index.graph.nodes.map((n) => n.id));
  const symbols = new Map(index.graph.nodes.flatMap((n): [string, SymbolLocation][] => (n.id.startsWith('sym:') && n.path ? [[n.id, { id: n.id, path: n.path, range: n.range }]] : [])));
  const validation = validateTasks(await loadTaskValues(resolve(benchDir, 'tasks')), files, nodeIds, await loadRejected(resolve(benchDir, 'tasks', 'rejected.txt')));
  if (validation.errors.length) throw new Error(`task validation failed:\n${validation.errors.join('\n')}`);
  const gitSha = (await spawnGit(['rev-parse', 'HEAD'], repoRoot)).trim();

  const rows: { case: string; budget: number; row: ResultRow }[] = [];
  for (const name of names) {
    const overrides = CASES[name];
    if (!overrides) throw new Error(`unknown case ${name} (have ${Object.keys(CASES).join(', ')})`);
    for (const budget of budgets) {
      const options = { variant, budget, split, retriever: 'inproc' as const };
      const tasks = selectTasks(validation.tasks, options);
      const retriever = await realInProcessRetriever(variant, { root: repo, graphSnapshot: index.graph, configOverrides: overrides });
      const run = await runBenchmark(tasks, retriever, options, { gitSha, latency: 'context', symbolLocations: symbols });
      rows.push({ case: name, budget, row: run.row });
      const m = run.row.metrics;
      process.stdout.write(`${name.padEnd(10)} ${variant} ${split} ${String(budget).padStart(5)}  n=${run.row.n}  strict=${(100 * m.recallStrict).toFixed(2)}%  any=${(100 * m.recallAny).toFixed(2)}%  sym=${m.symbolRecall === undefined ? "n/a" : (100 * m.symbolRecall).toFixed(2) + "%"}  prec=${(100 * m.precisionTokens).toFixed(2)}%  p95=${Math.round(m.p95ms)}ms  graphFallback=${run.row.degraded['graph-replica'] ?? 0}  run=${run.row.runId}\n`);
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`);
  process.stdout.write(`saved ${out}\n`);
}

await main();
