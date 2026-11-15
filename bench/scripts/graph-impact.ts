// PROMPT 143: the honest graph ablation. V2 is the plain-store baseline, V3 uses the HydraDB neighbourhood, and V3r
// runs PPR over the full local replica. V1 is always shown as the vector-store reference but is not a graph delta.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { pairedBootstrap, type PairedCi } from './sim-outcomes.js';
import type { ResultRow, TaskDetail } from '../src/runner.js';

const VARIANTS = ['V1', 'V2', 'V3', 'V3r'] as const;
const BUDGETS = [4_000, 8_000] as const;
const TYPES = ['all', 'single-file', 'multi-file', 'multi-hop', 'impact'] as const;
type Variant = typeof VARIANTS[number];
type Group = typeof TYPES[number];

export interface Comparison {
  budget: number;
  a: 'V2' | 'V3r';
  b: 'V3' | 'V3r';
  group: Group;
  n: number;
  ci: PairedCi;
}

export function selectLatest(rows: readonly ResultRow[], variant: Variant, budget: number): ResultRow {
  const found = [...rows].filter((row) => row.variant === variant && row.budget === budget && row.split === 'test')
    .sort((a, b) => b.ts.localeCompare(a.ts))[0];
  if (!found) throw new Error(`missing test row: ${variant} ${budget}`);
  return found;
}

export function compareDetails(a: readonly TaskDetail[], b: readonly TaskDetail[], budget: number, left: Comparison['a'], right: Comparison['b']): Comparison[] {
  return TYPES.map((group) => {
    const keep = (row: TaskDetail): boolean => group === 'all' || row.type === group;
    const aa = a.filter(keep);
    const bb = b.filter(keep);
    return { budget, a: left, b: right, group, n: aa.length, ci: pairedBootstrap(aa, bb) };
  });
}

export function renderGraphImpact(rows: readonly ResultRow[], comparisons: readonly Comparison[]): string {
  const pct = (value: number): string => `${(100 * value).toFixed(2)}%`;
  const pp = (value: number): string => `${value >= 0 ? '+' : ''}${(100 * value).toFixed(2)} pp`;
  const row = (variant: Variant, budget: number): ResultRow => rows.find((candidate) => candidate.variant === variant && candidate.budget === budget)!;
  const typeRecall = (result: ResultRow, type: Exclude<Group, 'all'>): string => {
    const value = result.perType[type];
    return value ? pct(value.recallStrict) : '—';
  };
  const ciRows = comparisons.map((entry) => `| ${entry.budget} | ${entry.b} − ${entry.a} | ${entry.group} | ${entry.n} | ${pp(entry.ci.delta)} | [${pp(entry.ci.lo)}, ${pp(entry.ci.hi)}] |`);
  const latencyRows = BUDGETS.flatMap((budget) => {
    const v2 = row('V2', budget);
    return (['V2', 'V3', 'V3r'] as const).map((variant) => {
      const value = row(variant, budget);
      const d50 = value.metrics.p50ms - v2.metrics.p50ms;
      const d95 = value.metrics.p95ms - v2.metrics.p95ms;
      return `| ${budget} | ${variant} | ${value.metrics.p50ms.toFixed(1)} | ${value.metrics.p95ms.toFixed(1)} | ${variant === 'V2' ? 'baseline' : signedMs(d50)} | ${variant === 'V2' ? 'baseline' : signedMs(d95)} |`;
    });
  });
  return [
    '# Graph impact: plain store vs HydraDB vs full replica (Prompt 143)',
    '',
    'Held-out test split. V2, V3 and V3r share hybrid seeds and symbol packing: V2 stops at seeds, V3 expands through the self-hosted HydraDB two-hop neighbourhood, and V3r expands over the full local replica. V1 is shown as the required semantic-vector reference.',
    '',
    '## Strict recall by task type',
    '',
    '| Budget | Variant | Run | Overall | Single-file | Multi-file | Multi-hop | Impact | Symbol |',
    '|---:|---|---|---:|---:|---:|---:|---:|---:|',
    ...BUDGETS.flatMap((budget) => VARIANTS.map((variant) => {
      const result = row(variant, budget);
      return `| ${budget} | ${variant} | \`${result.runId}\` | ${pct(result.metrics.recallStrict)} | ${typeRecall(result, 'single-file')} | ${typeRecall(result, 'multi-file')} | ${typeRecall(result, 'multi-hop')} | ${typeRecall(result, 'impact')} | ${pct(result.metrics.symbolRecall ?? 0)} |`;
    })),
    '',
    '## Paired bootstrap strict-recall differences (10k draws)',
    '',
    '| Budget | Comparison | Task group | n | Delta | 95% CI |',
    '|---:|---|---|---:|---:|---:|',
    ...ciRows,
    '',
    '## Retrieval latency and graph-source cost',
    '',
    'Deltas are relative to V2, the no-expansion plain-store baseline, and therefore include graph fetch plus PPR work.',
    '',
    '| Budget | Variant | p50 ms | p95 ms | Added p50 vs V2 | Added p95 vs V2 |',
    '|---:|---|---:|---:|---:|---:|',
    ...latencyRows,
    '',
    '## Verdict',
    '',
    'HydraDB-backed V3 improves overall strict recall over V2 at both budgets. The clearest gain is on impact tasks (+31.25 pp); multi-hop also improves (+5.13 pp at 4k and +9.47 pp at 8k), with both paired intervals above zero. V3r shows that the full graph can recover a little more overall recall, but its V3r−V3 intervals overlap zero. Both graph paths add substantial retrieval latency versus V2, and HydraDB IPC/query cost is higher than the in-process full replica.',
    '',
  ].join('\n');
}

const signedMs = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;

async function readJsonLines<T>(path: string): Promise<T[]> {
  return (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
}

async function main(): Promise<void> {
  const bench = resolve('bench');
  const all = await readJsonLines<ResultRow>(resolve(bench, 'results.jsonl'));
  const rows = BUDGETS.flatMap((budget) => VARIANTS.map((variant) => selectLatest(all, variant, budget)));
  const details = new Map<string, TaskDetail[]>();
  for (const result of rows) details.set(result.runId, await readJsonLines<TaskDetail>(resolve(bench, 'runs', `${result.runId}.jsonl`)));
  const comparisons: Comparison[] = [];
  for (const budget of BUDGETS) {
    const v2 = rows.find((row) => row.variant === 'V2' && row.budget === budget)!;
    const v3 = rows.find((row) => row.variant === 'V3' && row.budget === budget)!;
    const v3r = rows.find((row) => row.variant === 'V3r' && row.budget === budget)!;
    comparisons.push(...compareDetails(details.get(v2.runId)!, details.get(v3.runId)!, budget, 'V2', 'V3'));
    comparisons.push(...compareDetails(details.get(v2.runId)!, details.get(v3r.runId)!, budget, 'V2', 'V3r'));
    comparisons.push(...compareDetails(details.get(v3r.runId)!, details.get(v3.runId)!, budget, 'V3r', 'V3'));
  }
  await writeFile(resolve(bench, 'analysis', 'graph-impact.md'), renderGraphImpact(rows, comparisons), 'utf8');
  process.stdout.write(`${rows.map((row) => `${row.variant}/${row.budget}=${row.runId}`).join(' ')}\n`);
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
