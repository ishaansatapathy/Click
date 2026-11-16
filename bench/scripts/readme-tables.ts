// PROMPT 200: README benchmark tables are projections of results.jsonl, never hand-maintained numbers.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RECALL_VARIANTS = ['V1', 'V2', 'V3', 'V3r', 'V5'] as const;
const BUDGETS = [4_000, 8_000] as const;

interface RetrievalRow {
  runId: string;
  kind: 'retrieval';
  variant: string;
  budget: number;
  split: string;
  metrics: { recallStrict: number; symbolRecall?: number; p50ms: number; p95ms: number };
}

interface LatencyRow {
  runId: string;
  kind: 'latency';
  variant: string;
  n: number;
  metrics: { p50ms: number; p95ms: number };
}

interface E2eTaskResult {
  taskId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turns: number;
  wallMs: number;
  passed: boolean;
}

interface E2eRow {
  runId: string;
  kind: 'e2e';
  variant: string;
  n: number;
  solved: number;
  tokensPerSolved: number | null;
  totals: { inputTokens: number; outputTokens: number };
  tasks: E2eTaskResult[];
}

type ResultRow = RetrievalRow | LatencyRow | E2eRow | { kind?: unknown };

const percent = (value: number | undefined): string => value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
const integer = (value: number): string => Math.round(value).toLocaleString('en-US');
const milliseconds = (value: number): string => `${Math.round(value).toLocaleString('en-US')} ms`;

function latest<T>(rows: readonly T[], predicate: (row: T) => boolean, description: string): T {
  const matches = rows.filter(predicate);
  const row = matches.at(-1);
  if (!row) throw new Error(`Missing benchmark row: ${description}`);
  return row;
}

export function renderRecall(rows: readonly ResultRow[]): string {
  const retrieval = rows.filter((row): row is RetrievalRow => row.kind === 'retrieval');
  const lines = [
    '| Variant | 4k strict | 4k symbol | 8k strict | 8k symbol | Run IDs |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const variant of RECALL_VARIANTS) {
    const selected = BUDGETS.map((budget) => latest(retrieval, (row) => row.variant === variant && row.budget === budget && row.split === 'test', `${variant}, test, ${budget}`));
    const four = selected[0]!;
    const eight = selected[1]!;
    lines.push(`| ${variant} | ${percent(four.metrics.recallStrict)} | ${percent(four.metrics.symbolRecall)} | ${percent(eight.metrics.recallStrict)} | ${percent(eight.metrics.symbolRecall)} | \`${four.runId}\`, \`${eight.runId}\` |`);
  }
  return lines.join('\n');
}

export function renderLatency(rows: readonly ResultRow[]): string {
  const latency = rows.filter((row): row is LatencyRow => row.kind === 'latency');
  if (!latency.length) throw new Error('Missing benchmark row: kind=latency');
  return [
    '| Measurement | n | p50 | p95 | Run ID |',
    '| --- | ---: | ---: | ---: | --- |',
    ...latency.map((row) => `| ${row.variant} | ${row.n} | ${milliseconds(row.metrics.p50ms)} | ${milliseconds(row.metrics.p95ms)} | \`${row.runId}\` |`),
  ].join('\n');
}

export function renderE2e(rows: readonly ResultRow[]): string {
  const all = rows.filter((row): row is E2eRow => row.kind === 'e2e');
  const variants = ['V0', 'delivery'].map((variant) => latest(all, (row) => row.variant === variant, `kind=e2e, variant=${variant}`));
  const summary = [
    '| Variant | Solved | Tokens / solved | Total input | Total output | Run ID |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...variants.map((row) => `| ${row.variant} | ${row.solved}/${row.n} | ${row.tokensPerSolved === null ? '—' : integer(row.tokensPerSolved)} | ${integer(row.totals.inputTokens)} | ${integer(row.totals.outputTokens)} | \`${row.runId}\` |`),
  ];
  const details = [
    '| Task | Variant | Passed | Input | Output | Cache read | Cache create | Turns | Wall |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...variants.flatMap((row) => row.tasks.map((task) => `| \`${task.taskId}\` | ${row.variant} | ${task.passed ? 'yes' : 'no'} | ${integer(task.inputTokens)} | ${integer(task.outputTokens)} | ${integer(task.cacheReadTokens)} | ${integer(task.cacheCreationTokens)} | ${task.turns} | ${(task.wallMs / 1_000).toFixed(1)} s |`)),
  ];
  return `${summary.join('\n')}\n\n${details.join('\n')}`;
}

export function replaceMarkedSection(markdown: string, name: string, body: string): string {
  const start = `<!-- bench:${name}:start -->`;
  const end = `<!-- bench:${name}:end -->`;
  const startAt = markdown.indexOf(start);
  const endAt = markdown.indexOf(end);
  if (startAt < 0 || endAt < 0 || endAt < startAt) throw new Error(`README marker pair missing or out of order: ${name}`);
  if (markdown.indexOf(start, startAt + start.length) >= 0 || markdown.indexOf(end, endAt + end.length) >= 0) throw new Error(`README marker pair is duplicated: ${name}`);
  return `${markdown.slice(0, startAt)}${start}\n${body.trimEnd()}\n${end}${markdown.slice(endAt + end.length)}`;
}

export async function generateReadmeTables(resultsPath: string, readmePath: string): Promise<void> {
  const lines = (await readFile(resultsPath, 'utf8')).split(/\r?\n/).filter(Boolean);
  const rows = lines.map((line, index) => {
    try { return JSON.parse(line) as ResultRow; }
    catch { throw new Error(`Invalid JSON in ${resultsPath} at line ${index + 1}`); }
  });
  let markdown = await readFile(readmePath, 'utf8');
  markdown = replaceMarkedSection(markdown, 'recall', renderRecall(rows));
  markdown = replaceMarkedSection(markdown, 'latency', renderLatency(rows));
  markdown = replaceMarkedSection(markdown, 'e2e', renderE2e(rows));
  await writeFile(readmePath, markdown, 'utf8');
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  const benchRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  generateReadmeTables(resolve(benchRoot, 'results.jsonl'), resolve(benchRoot, '..', 'README.md')).catch((error: unknown) => {
    process.stderr.write(`readme:tables: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
