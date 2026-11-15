import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { ClassifiedCandidate, TaskType } from './classify.js';
import { spawnGit } from './fetch-repo.js';

export type TaskSplit = 'train' | 'test';

export interface BenchTask {
  id: string;
  source: 'mined';
  commit: string;
  parentCommit: string;
  date: string;
  text: string;
  type: TaskType;
  groundTruth: { files: string[]; symbols: string[] };
  split: TaskSplit;
  e2e: boolean;
  check?: { kind: 'vue-tsc+vitest'; tests: string[] };
}

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TRAIN_SHARE = 0.7;
export const VERIFIED_E2E = new Set([
  'm-f74fe7b',
  'm-2e26908',
  'm-031c5c1',
  'm-4f4b23d',
  'm-95a8604',
  'm-5f733a8',
  'm-cbd9e02',
  'm-caa9c84',
]);

export function splitCandidates(candidates: readonly ClassifiedCandidate[]): Map<string, TaskSplit> {
  const ordered = [...candidates].sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || compare(a.sha, b.sha));
  const trainCount = Math.floor(ordered.length * TRAIN_SHARE);
  return new Map(ordered.map((candidate, index) => [candidate.sha, index < trainCount ? 'train' : 'test']));
}

export function toBenchTask(candidate: ClassifiedCandidate, split: TaskSplit, parentCommit: string): BenchTask {
  if (!candidate.text) throw new Error(`candidate ${candidate.sha} has no task text`);
  const id = `m-${candidate.sha.slice(0, 7)}`;
  const e2e = VERIFIED_E2E.has(id);
  if (e2e && (split !== 'test' || candidate.groundTruthFiles.length > 4)) {
    throw new Error(`verified e2e task ${id} violates held-out/size constraints`);
  }
  return {
    id,
    source: 'mined',
    commit: candidate.sha,
    parentCommit,
    date: candidate.date,
    text: candidate.text,
    type: candidate.type,
    groundTruth: { files: candidate.groundTruthFiles, symbols: candidate.groundTruthSymbols },
    split,
    e2e,
    ...(e2e ? { check: { kind: 'vue-tsc+vitest' as const, tests: [`bench/e2e/checks/${id}.test.ts`] } } : {}),
  };
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  const result: T[] = [];
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) result.push(JSON.parse(line) as T);
  return result;
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

async function main(): Promise<void> {
  const repo = resolve(benchDir, 'repo');
  const candidates = await readJsonLines<ClassifiedCandidate>(resolve(benchDir, 'data', 'classified.jsonl'));
  const splitBySha = splitCandidates(candidates);
  const outputDir = resolve(benchDir, 'tasks', 'mined');
  await mkdir(outputDir, { recursive: true });
  const tasks: BenchTask[] = [];
  for (const candidate of candidates) {
    const parent = (await spawnGit(['rev-parse', `${candidate.sha}^`], repo)).trim();
    const task = toBenchTask(candidate, splitBySha.get(candidate.sha)!, parent);
    tasks.push(task);
    await writeFile(resolve(outputDir, `${task.id}.json`), `${JSON.stringify(task, null, 2)}\n`, 'utf8');
  }
  const counts = { train: 0, test: 0, e2e: 0 };
  for (const task of tasks) {
    counts[task.split]++;
    if (task.e2e) counts.e2e++;
  }
  process.stdout.write(`Wrote ${tasks.length} mined tasks: train=${counts.train}, test=${counts.test}, e2e=${counts.e2e}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
