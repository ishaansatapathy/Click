import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { gitBaselineRepo, oracleRetriever, randomRetriever, type BaselineRepo } from '../src/dummy-retrievers.js';
import { runBenchmark, writeRunArtifacts, type ResultRow, type RunnerOptions } from '../src/runner.js';
import type { BenchTask } from '../src/task.js';
import { loadBenchConfig, spawnGit } from './fetch-repo.js';
import type { TaskTextRecord } from './write-task-text.js';

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function gateTasks(records: TaskTextRecord[], rejected: ReadonlySet<string>): BenchTask[] {
  const tasks = records
    .filter((record) => !rejected.has(record.sha) && !rejected.has(`m-${record.sha.slice(0, 7)}`))
    .map((record): BenchTask => ({
      id: `m-${record.sha.slice(0, 7)}`,
      source: 'mined',
      commit: record.sha,
      date: record.date,
      text: record.text,
      type: record.groundTruthFiles.length === 1 ? 'single-file' : 'multi-file',
      groundTruth: { files: record.groundTruthFiles, symbols: [] },
      split: 'train',
      e2e: false,
    }));
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) throw new Error('mined task SHA prefixes are not unique');
  return tasks;
}

export function memoizeRepo(repo: BaselineRepo): BaselineRepo {
  let files: Promise<string[]> | undefined;
  const bodies = new Map<string, Promise<string>>();
  return {
    listSourceFiles() {
      return files ??= repo.listSourceFiles();
    },
    readFile(path) {
      let body = bodies.get(path);
      if (!body) {
        body = repo.readFile(path);
        bodies.set(path, body);
      }
      return body;
    },
  };
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  return (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
}

async function runGate(): Promise<ResultRow[]> {
  const config = loadBenchConfig(resolve(benchDir, 'bench.config.json'));
  const records = await readJsonLines<TaskTextRecord>(resolve(benchDir, 'data', 'task-texts.jsonl'));
  const rejected = new Set((await readFile(resolve(benchDir, 'tasks', 'rejected.txt'), 'utf8')).split(/\r?\n/).filter(Boolean));
  const tasks = gateTasks(records, rejected);
  if (!tasks.length) throw new Error('no accepted mined tasks for G1a');
  const repo = memoizeRepo(gitBaselineRepo(resolve(benchDir, 'repo'), config.pinnedSha));
  const gitSha = (await spawnGit(['rev-parse', 'HEAD'], resolve(benchDir, '..'))).trim();
  const rows: ResultRow[] = [];
  const variants = process.argv.includes('--random-only') ? ['random'] as const : ['oracle', 'random'] as const;
  for (const variant of variants) {
    for (const budget of [4_000, 8_000]) {
      const options: RunnerOptions = { variant, budget, split: 'all', retriever: variant };
      const retriever = variant === 'oracle' ? oracleRetriever(repo) : randomRetriever(repo, 42);
      const run = await runBenchmark(tasks, retriever, options, { gitSha, latency: 'context' });
      await writeRunArtifacts(benchDir, run);
      rows.push(run.row);
      process.stdout.write(`${variant} ${budget}: strict=${run.row.metrics.recallStrict.toFixed(4)}, any=${run.row.metrics.recallAny.toFixed(4)}, n=${run.row.n}\n`);
    }
  }
  return rows;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) void runGate().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
