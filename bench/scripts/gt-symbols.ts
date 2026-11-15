import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

import type { SourceFile } from '../../packages/core/src/contracts.js';
import { buildIndex } from '../../packages/core/src/indexer/build.js';
import { classifyFile, isCandidate, normaliseContent } from '../../packages/core/src/indexer/discover.js';
import { buildExtractCtx, extractFile } from '../../packages/core/src/indexer/extract.js';
import { profileRepo, type RepoProfile } from '../../packages/core/src/indexer/profile.js';
import type { GraphNode, LineRange } from '../../packages/core/src/types.js';
import { sha1 } from '../../packages/core/src/util/hash.js';
import { spawnGit } from './fetch-repo.js';
import type { CandidateCommit } from './filter-commits.js';

export interface DiffRanges {
  pre: Map<string, LineRange[]>;
  post: Map<string, LineRange[]>;
}

export interface CandidateSymbols extends CandidateCommit {
  groundTruthSymbols: string[];
  signatureChangedSymbols: string[];
}

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function parseDiffRanges(diff: string): DiffRanges {
  const pre = new Map<string, LineRange[]>();
  const post = new Map<string, LineRange[]>();
  let oldPath: string | undefined;
  let newPath: string | undefined;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('--- ')) oldPath = diffPath(line.slice(4));
    else if (line.startsWith('+++ ')) newPath = diffPath(line.slice(4));
    else if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) continue;
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      if (oldPath && oldCount > 0) pushRange(pre, oldPath, Number(match[1]), oldCount);
      if (newPath && newCount > 0) pushRange(post, newPath, Number(match[3]), newCount);
    }
  }
  return { pre, post };
}

export function overlappingSymbols(nodes: readonly GraphNode[], ranges: ReadonlyMap<string, LineRange[]>): GraphNode[] {
  return nodes.filter((node) => node.kind !== 'file' && node.range && ranges.get(node.path ?? '')?.some((range) => overlaps(node.range!, range)));
}

export function translateSymbolsAtH(
  historical: readonly GraphNode[],
  hNodes: readonly GraphNode[],
  groundTruthFiles: readonly string[],
): GraphNode[] {
  const allowed = new Set(groundTruthFiles);
  const byId = new Map(hNodes.map((node) => [node.id, node]));
  const result = new Map<string, GraphNode>();
  for (const symbol of historical) {
    const exact = byId.get(symbol.id);
    const translated = exact && allowed.has(exact.path ?? '')
      ? exact
      : hNodes.find((node) => allowed.has(node.path ?? '') && node.kind === symbol.kind && node.name === symbol.name);
    if (translated) result.set(translated.id, translated);
  }
  return [...result.values()].sort((a, b) => compare(a.id, b.id));
}

export async function mapCandidateSymbols(
  repo: string,
  candidate: CandidateCommit,
  hNodes: readonly GraphNode[],
  allPathsCache = new Map<string, Set<string>>(),
  profile: RepoProfile = profileRepo(repo),
): Promise<CandidateSymbols> {
  const parent = (await spawnGit(['rev-parse', `${candidate.sha}^`], repo)).trim();
  const diff = await spawnGit(['diff', '--unified=0', '--no-ext-diff', parent, candidate.sha, '--', ...candidate.files.flatMap((file) => file.oldPath ? [file.oldPath, file.path] : [file.path])], repo);
  const ranges = parseDiffRanges(diff);
  const pre = await extractRevision(repo, parent, ranges.pre, profile, allPathsCache);
  const post = await extractRevision(repo, candidate.sha, ranges.post, profile, allPathsCache);
  const preOverlaps = overlappingSymbols(pre, ranges.pre);
  const postOverlaps = overlappingSymbols(post, ranges.post);
  const translated = translateSymbolsAtH([...preOverlaps, ...postOverlaps], hNodes, candidate.groundTruthFiles);
  const preByIdentity = new Map(preOverlaps.map((node) => [`${node.kind}\0${node.name}`, node]));
  const changedHistorical = postOverlaps.filter((node) => {
    const before = preByIdentity.get(`${node.kind}\0${node.name}`);
    return before !== undefined && before.signature !== node.signature;
  });
  const changed = new Set(translateSymbolsAtH(changedHistorical, hNodes, candidate.groundTruthFiles).map((node) => node.id));
  return {
    ...candidate,
    groundTruthSymbols: translated.map((node) => node.id),
    signatureChangedSymbols: [...changed].sort(compare),
  };
}

async function extractRevision(
  repo: string,
  revision: string,
  ranges: ReadonlyMap<string, LineRange[]>,
  profile: RepoProfile,
  allPathsCache: Map<string, Set<string>>,
): Promise<GraphNode[]> {
  const paths = [...ranges.keys()].filter(isCandidate);
  const files = (await Promise.all(paths.map((path) => sourceAt(repo, revision, path)))).filter((file): file is SourceFile => file !== null);
  let allPaths = allPathsCache.get(revision);
  if (!allPaths) {
    allPaths = new Set((await spawnGit(['ls-tree', '-r', '--name-only', revision], repo)).split(/\r?\n/).filter(Boolean));
    allPathsCache.set(revision, allPaths);
  }
  const context = buildExtractCtx(repo, profile, files, allPaths);
  return files.flatMap((file) => extractFile(file, context).nodes);
}

async function sourceAt(repo: string, revision: string, path: string): Promise<SourceFile | null> {
  try {
    const content = normaliseContent(await spawnGit(['show', `${revision}:${path}`], repo));
    return { path, content, hash: sha1(content), class: classifyFile(path) };
  } catch {
    return null;
  }
}

function diffPath(value: string): string | undefined {
  if (value === '/dev/null') return undefined;
  return value.replace(/^[ab]\//, '').replace(/^"|"$/g, '');
}

function pushRange(target: Map<string, LineRange[]>, path: string, startLine: number, count: number): void {
  const ranges = target.get(path) ?? [];
  ranges.push({ startLine, endLine: startLine + count - 1 });
  target.set(path, ranges);
}

function overlaps(a: LineRange, b: LineRange): boolean {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

async function readCandidates(path: string): Promise<CandidateCommit[]> {
  const result: CandidateCommit[] = [];
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) result.push(JSON.parse(line) as CandidateCommit);
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
  const candidates = await readCandidates(resolve(benchDir, 'data', 'candidates.jsonl'));
  const hNodes = (await buildIndex(repo)).graph.nodes;
  const profile = profileRepo(repo);
  const cache = new Map<string, Set<string>>();
  const result: CandidateSymbols[] = [];
  for (let index = 0; index < candidates.length; index++) {
    result.push(await mapCandidateSymbols(repo, candidates[index]!, hNodes, cache, profile));
    if ((index + 1) % 25 === 0) process.stdout.write(`Mapped ${index + 1}/${candidates.length}\n`);
  }
  const output = resolve(benchDir, 'data', 'candidate-symbols.jsonl');
  await writeJsonLines(output, result);
  process.stdout.write(`Wrote ${result.length} candidates with ${result.reduce((sum, item) => sum + item.groundTruthSymbols.length, 0)} ground-truth symbols to ${output}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
