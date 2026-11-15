import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildIndex } from '../../packages/core/src/indexer/build.js';
import type { Convention, Graph } from '../../packages/core/src/types.js';
import type { CandidateSymbols } from './gt-symbols.js';

export type TaskType = 'single-file' | 'multi-file' | 'multi-hop' | 'impact' | 'convention';

interface TaskTextFields {
  text?: string;
  taskText?: unknown;
}

export interface ClassifiedCandidate extends CandidateSymbols, TaskTextFields {
  type: TaskType;
}

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'code', 'components', 'do', 'existing', 'files', 'for', 'from',
  'in', 'is', 'it', 'keep', 'new', 'not', 'of', 'on', 'or', 'repo', 'such', 'the', 'them', 'they', 'this', 'to', 'use', 'with',
]);

export function classifyCandidate(candidate: CandidateSymbols & TaskTextFields, graph: Graph, conventions: readonly Convention[]): TaskType {
  if (candidate.groundTruthFiles.length === 1) return 'single-file';
  if (isImpact(candidate, graph)) return 'impact';
  if (isMultiHop(candidate.groundTruthFiles, graph)) return 'multi-hop';
  if (matchingConvention(candidate.text ?? candidate.message, conventions)) return 'convention';
  return 'multi-file';
}

export function isImpact(candidate: Pick<CandidateSymbols, 'signatureChangedSymbols'>, graph: Graph): boolean {
  const changed = new Set(candidate.signatureChangedSymbols);
  if (changed.size === 0) return false;
  const dependents = new Map<string, Set<string>>([...changed].map((id) => [id, new Set()]));
  for (const edge of graph.edges) {
    if (edge.kind === 'contains' || !changed.has(edge.to)) continue;
    dependents.get(edge.to)!.add(edge.from);
  }
  return [...dependents.values()].some((items) => items.size >= 3);
}

export function isMultiHop(files: readonly string[], graph: Graph): boolean {
  const fileIds = files.map((path) => `file:${path}`).filter((id) => graph.nodes.some((node) => node.id === id));
  if (fileIds.length < 2) return false;
  const adjacency = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    addNeighbour(adjacency, edge.from, edge.to);
    addNeighbour(adjacency, edge.to, edge.from);
  }
  for (let index = 0; index < fileIds.length; index++) {
    const distances = shortestDistances(fileIds[index]!, adjacency);
    for (const target of fileIds.slice(index + 1)) {
      const distance = distances.get(target);
      if (distance !== undefined && distance >= 2) return true;
    }
  }
  return false;
}

export function matchingConvention(text: string, conventions: readonly Convention[]): string | null {
  const taskTokens = tokens(text);
  let best: { id: string; overlap: number; coverage: number } | undefined;
  for (const convention of conventions) {
    const conventionTokens = tokens(convention.text);
    const overlap = [...conventionTokens].filter((token) => taskTokens.has(token)).length;
    const coverage = overlap / Math.min(6, Math.max(1, conventionTokens.size));
    if (overlap < 2 || coverage < 0.34) continue;
    if (!best || overlap > best.overlap || (overlap === best.overlap && coverage > best.coverage)) {
      best = { id: convention.id, overlap, coverage };
    }
  }
  return best?.id ?? null;
}

function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .map((token) => token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token)));
}

function addNeighbour(adjacency: Map<string, Set<string>>, from: string, to: string): void {
  const neighbours = adjacency.get(from) ?? new Set<string>();
  neighbours.add(to);
  adjacency.set(from, neighbours);
}

function shortestDistances(source: string, adjacency: ReadonlyMap<string, ReadonlySet<string>>): Map<string, number> {
  const distances = new Map([[source, 0]]);
  const queue = [source];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!;
    const distance = distances.get(current)!;
    for (const next of adjacency.get(current) ?? []) {
      if (distances.has(next)) continue;
      distances.set(next, distance + 1);
      queue.push(next);
    }
  }
  return distances;
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  const result: T[] = [];
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) result.push(JSON.parse(line) as T);
  return result;
}

async function writeJsonLines(path: string, values: readonly unknown[]): Promise<void> {
  const output = createWriteStream(path, { encoding: 'utf8' });
  for (const value of values) if (!output.write(`${JSON.stringify(value)}\n`)) await once(output, 'drain');
  output.end();
  await once(output, 'finish');
}

async function main(): Promise<void> {
  const repo = resolve(benchDir, 'repo');
  const candidates = await readJsonLines<CandidateSymbols>(resolve(benchDir, 'data', 'candidate-symbols.jsonl'));
  const taskTexts = await readJsonLines<CandidateSymbols & TaskTextFields>(resolve(benchDir, 'data', 'task-texts.jsonl'));
  const textBySha = new Map(taskTexts.map(({ sha, text, taskText }) => [sha, { text, taskText }]));
  const { graph, conventions } = await buildIndex(repo);
  const result: ClassifiedCandidate[] = candidates.map((candidate) => {
    const merged = { ...candidate, ...textBySha.get(candidate.sha) };
    return { ...merged, type: classifyCandidate(merged, graph, conventions) };
  });
  const output = resolve(benchDir, 'data', 'classified.jsonl');
  await writeJsonLines(output, result);
  const distribution = new Map<TaskType, number>();
  for (const candidate of result) distribution.set(candidate.type, (distribution.get(candidate.type) ?? 0) + 1);
  for (const type of ['single-file', 'impact', 'multi-hop', 'convention', 'multi-file'] as const) {
    process.stdout.write(`${type}: ${distribution.get(type) ?? 0}\n`);
  }
  process.stdout.write(`Wrote ${result.length} classified candidates to ${output}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
