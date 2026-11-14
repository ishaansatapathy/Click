import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { ResultRow, TaskDetail } from './runner.js';

export interface DiffEntry {
  taskId: string;
  a: number;
  b: number;
  delta: number;
  missingA: string[];
  missingB: string[];
  replacementReasonsA: string[];
  replacementReasonsB: string[];
}

export interface RunDiff {
  a: ResultRow;
  b: ResultRow;
  pairedTasks: number;
  wins: DiffEntry[];
  losses: DiffEntry[];
}

export function resolveRun(rows: ResultRow[], selector: string): ResultRow {
  const exact = rows.find((row) => row.runId === selector);
  if (exact) return exact;
  const variants = rows.filter((row) => row.variant === selector);
  if (!variants.length) throw new Error(`No run found for selector: ${selector}`);
  return variants.reduce((latest, row) => row.ts >= latest.ts ? row : latest);
}

export function compareRuns(a: ResultRow, b: ResultRow, detailsA: TaskDetail[], detailsB: TaskDetail[]): RunDiff {
  const byA = new Map(detailsA.map((detail) => [detail.taskId, detail]));
  const byB = new Map(detailsB.map((detail) => [detail.taskId, detail]));
  const paired = [...byA.keys()].filter((id) => byB.has(id)).sort().map((taskId) => {
    const left = byA.get(taskId)!;
    const right = byB.get(taskId)!;
    return {
      taskId,
      a: left.recallStrict,
      b: right.recallStrict,
      delta: right.recallStrict - left.recallStrict,
      missingA: left.missingGroundTruthFiles,
      missingB: right.missingGroundTruthFiles,
      replacementReasonsA: replacementReasons(left),
      replacementReasonsB: replacementReasons(right),
    } satisfies DiffEntry;
  });
  const wins = paired.filter((entry) => entry.delta > 0).sort((x, y) => y.delta - x.delta || x.taskId.localeCompare(y.taskId)).slice(0, 10);
  const losses = paired.filter((entry) => entry.delta < 0).sort((x, y) => x.delta - y.delta || x.taskId.localeCompare(y.taskId)).slice(0, 10);
  return { a, b, pairedTasks: paired.length, wins, losses };
}

export function renderRunDiff(diff: RunDiff): string {
  const lines = [
    `A ${diff.a.runId} (${diff.a.variant})`,
    `B ${diff.b.runId} (${diff.b.variant})`,
    `Paired tasks: ${diff.pairedTasks}`,
    '',
    'Top wins (B - A)',
    ...renderEntries(diff.wins),
    '',
    'Top losses (B - A)',
    ...renderEntries(diff.losses),
  ];
  return `${lines.join('\n')}\n`;
}

function renderEntries(entries: DiffEntry[]): string[] {
  if (!entries.length) return ['  (none)'];
  return entries.flatMap((entry) => [
    `  ${entry.taskId}: ${signed(entry.delta)} (${entry.a.toFixed(3)} -> ${entry.b.toFixed(3)})`,
    `    missing A: ${entry.missingA.join(', ') || '(none)'}`,
    `    missing B: ${entry.missingB.join(', ') || '(none)'}`,
    `    replacement reasons A: ${entry.replacementReasonsA.join('; ') || '(none)'}`,
    `    replacement reasons B: ${entry.replacementReasonsB.join('; ') || '(none)'}`,
  ]);
}

function replacementReasons(detail: TaskDetail): string[] {
  const groundTruth = new Set(detail.groundTruthFiles);
  return [...new Set(detail.items
    .filter((item) => item.path === null || !groundTruth.has(item.path))
    .flatMap((item) => item.reasons))];
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  return (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
}

function parseArgs(args: readonly string[]): { a: string; b: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== '--a' && flag !== '--b') || !value) throw new Error('Usage: pnpm bench:diff --a <runId|variant> --b <runId|variant>');
    values.set(flag.slice(2), value);
  }
  const a = values.get('a');
  const b = values.get('b');
  if (!a || !b) throw new Error('Usage: pnpm bench:diff --a <runId|variant> --b <runId|variant>');
  return { a, b };
}

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const selectors = parseArgs(process.argv.slice(2));
  const rows = await readJsonLines<ResultRow>(resolve(benchDir, 'results.jsonl'));
  const a = resolveRun(rows, selectors.a);
  const b = resolveRun(rows, selectors.b);
  const detailsA = await readJsonLines<TaskDetail>(resolve(benchDir, 'runs', `${a.runId}.jsonl`));
  const detailsB = await readJsonLines<TaskDetail>(resolve(benchDir, 'runs', `${b.runId}.jsonl`));
  process.stdout.write(renderRunDiff(compareRuns(a, b, detailsA, detailsB)));
}
