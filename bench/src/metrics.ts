import type { LineRange, PackedContext } from '../../packages/core/src/types.js';
import type { BenchTask } from './task.js';

type PackedItems = Pick<PackedContext, 'items'>;

export interface SymbolLocation {
  id: string;
  path: string;
  range?: LineRange;
}

export interface TypeMetricInput {
  type: BenchTask['type'];
  recallStrict: number;
}

export interface TypeMetric {
  n: number;
  recallStrict: number;
}

export interface BootstrapResult {
  diff: number;
  lo: number;
  hi: number;
}

export function recallStrict(task: BenchTask, context: PackedItems): number {
  return fileRecall(task, context, (mode) => mode === 'body' || mode === 'file');
}

export function recallAny(task: BenchTask, context: PackedItems): number {
  return fileRecall(task, context, () => true);
}

export function symbolRecall(
  task: BenchTask,
  context: PackedItems,
  symbolsById: ReadonlyMap<string, SymbolLocation>,
): number | null {
  if (task.groundTruth.symbols.length === 0) return null;
  let covered = 0;
  for (const id of new Set(task.groundTruth.symbols)) {
    const symbol = symbolsById.get(id);
    if (!symbol) continue;
    if (context.items.some((item) => coversSymbol(item, symbol))) covered++;
  }
  return covered / new Set(task.groundTruth.symbols).size;
}

export function precisionTokens(task: BenchTask, context: PackedItems): number {
  const groundTruth = new Set(task.groundTruth.files);
  let relevant = 0;
  let total = 0;
  for (const item of context.items) {
    if (item.mode === 'ref') continue;
    total += item.tokens;
    if ((item.mode === 'body' || item.mode === 'file') && item.path !== null && groundTruth.has(item.path)) {
      relevant += item.tokens;
    }
  }
  return total === 0 ? 0 : relevant / total;
}

export function perType(values: readonly TypeMetricInput[]): Record<string, TypeMetric> {
  const sums = new Map<BenchTask['type'], { n: number; recall: number }>();
  for (const value of values) {
    const current = sums.get(value.type) ?? { n: 0, recall: 0 };
    current.n++;
    current.recall += value.recallStrict;
    sums.set(value.type, current);
  }
  return Object.fromEntries([...sums.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([type, value]) => [
    type, { n: value.n, recallStrict: value.recall / value.n },
  ]));
}

export function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) throw new Error('percentile requires at least one value');
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) throw new Error('quantile must be between 0 and 1');
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const fraction = position - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * fraction;
}

export function pairedBootstrap(
  a: readonly number[],
  b: readonly number[],
  iterations = 2_000,
  seed = 42,
): BootstrapResult {
  if (a.length === 0 || a.length !== b.length) throw new Error('paired samples must have equal, non-zero length');
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error('iterations must be a positive integer');
  const random = mulberry32(seed);
  const sampledDiffs = new Array<number>(iterations);
  for (let iteration = 0; iteration < iterations; iteration++) {
    let sum = 0;
    for (let draw = 0; draw < a.length; draw++) {
      const index = Math.floor(random() * a.length);
      sum += b[index]! - a[index]!;
    }
    sampledDiffs[iteration] = sum / a.length;
  }
  const differences = a.map((value, index) => b[index]! - value);
  return {
    diff: differences.reduce((sum, value) => sum + value, 0) / differences.length,
    lo: percentile(sampledDiffs, 0.025),
    hi: percentile(sampledDiffs, 0.975),
  };
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = value + Math.imul(value ^ (value >>> 7), 61 | value) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function fileRecall(task: BenchTask, context: PackedItems, accepts: (mode: PackedContext['items'][number]['mode']) => boolean): number {
  const files = new Set(task.groundTruth.files);
  if (files.size === 0) return 0;
  const found = new Set(context.items.filter((item) => item.path !== null && accepts(item.mode)).map((item) => item.path!));
  let covered = 0;
  for (const file of files) if (found.has(file)) covered++;
  return covered / files.size;
}

function coversSymbol(item: PackedContext['items'][number], symbol: SymbolLocation): boolean {
  if (item.mode !== 'body' && item.mode !== 'file') return false;
  if (item.nodeId === symbol.id) return true;
  if (item.path !== symbol.path) return false;
  if (item.mode === 'file') return true;
  if (!item.range || !symbol.range) return false;
  return item.range.startLine <= symbol.range.startLine && item.range.endLine >= symbol.range.endLine;
}
