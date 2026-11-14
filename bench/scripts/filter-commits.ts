import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import { loadBenchConfig } from './fetch-repo.js';
import { GIT_LOG_FORMAT, parseNumstatRecords, type MinedCommit } from './mine-commits.js';

export type RejectionReason =
  | 'message' | 'bot' | 'source-file-count' | 'changed-lines' | 'whitespace-only' | 'missing-at-h';

export interface CandidateCommit extends MinedCommit {
  groundTruthFiles: string[];
  changedLines: number;
}

export interface FilterResult {
  candidates: CandidateCommit[];
  rejected: Record<RejectionReason, number>;
}

const REJECT_MESSAGE = /^(chore|build|ci|style|release|bump|merge|revert)\b/i;
const BOT = /(dependabot|renovate|github-actions|\[bot\]|bot@)/i;
const SOURCE_EXTENSIONS = /\.(vue|ts|tsx|js|mjs)$/i;

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function filterCommits(
  commits: MinedCommit[],
  filesAtH: ReadonlySet<string>,
  whitespaceChangedLines: ReadonlyMap<string, number>,
): FilterResult {
  const futurePath = buildFuturePathMap(commits, filesAtH);
  const candidates: CandidateCommit[] = [];
  const rejected = emptyRejections();

  for (const commit of commits) {
    const subject = commit.message.split(/\r?\n/, 1)[0] ?? '';
    if (REJECT_MESSAGE.test(subject)) { rejected.message++; continue; }
    if (BOT.test(`${commit.authorName} ${commit.authorEmail}`)) { rejected.bot++; continue; }

    const sourceFiles = commit.files.filter((file) => isSourcePath(file.path));
    if (sourceFiles.length < 1 || sourceFiles.length > 8) { rejected['source-file-count']++; continue; }
    const changedLines = sourceFiles.reduce((sum, file) => sum + (file.insertions ?? 0) + (file.deletions ?? 0), 0);
    if (changedLines > 400) { rejected['changed-lines']++; continue; }
    if ((whitespaceChangedLines.get(commit.sha) ?? 0) === 0) { rejected['whitespace-only']++; continue; }

    const groundTruthFiles = [...new Set(sourceFiles.map((file) => futurePath.get(file.path) ?? file.path))].sort();
    if (groundTruthFiles.some((path) => !filesAtH.has(path))) { rejected['missing-at-h']++; continue; }
    candidates.push({ ...commit, groundTruthFiles, changedLines });
  }

  return { candidates, rejected };
}

export function buildFuturePathMap(
  commitsNewestFirst: MinedCommit[],
  filesAtH: ReadonlySet<string>,
): Map<string, string> {
  const future = new Map<string, string>();
  for (const path of filesAtH) future.set(path, path);
  for (const commit of commitsNewestFirst) {
    for (const file of commit.files) {
      if (!file.oldPath) continue;
      const destination = future.get(file.path);
      if (destination) future.set(file.oldPath, destination);
    }
  }
  return future;
}

function isSourcePath(path: string): boolean {
  if (!SOURCE_EXTENSIONS.test(path) || /\.d\.ts$/i.test(path)) return false;
  if (/(^|\/)(tests?|__tests__|dist|coverage|generated)(\/|$)/i.test(path)) return false;
  if (/(^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path)) return false;
  if (/(^|\/)(?:vite|vitest|eslint|playwright|rollup|tsup)\.config\.[cm]?[jt]s$/i.test(path)) return false;
  return /(^|\/)src\//.test(path);
}

async function readCommits(path: string): Promise<MinedCommit[]> {
  const commits: MinedCommit[] = [];
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) commits.push(JSON.parse(line) as MinedCommit);
  return commits;
}

export async function whitespaceStats(repo: string, beforeSha: string): Promise<Map<string, number>> {
  const stream = spawnGitStream(repo, [
    'log', '--no-merges', '-M', '-w', `--format=${GIT_LOG_FORMAT}`, `${beforeSha}^`, '--numstat',
  ]);
  const result = new Map<string, number>();
  for await (const record of parseNumstatRecords(stream)) {
    result.set(record.sha, record.stats.reduce((sum, item) => sum + (item.insertions ?? 0) + (item.deletions ?? 0), 0));
  }
  return result;
}

export async function filesAtRevision(repo: string, sha: string): Promise<Set<string>> {
  const output = await collectText(spawnGitStream(repo, ['ls-tree', '-r', '--name-only', sha]));
  return new Set(output.split(/\r?\n/).filter(Boolean));
}

function spawnGitStream(repo: string, args: readonly string[]): Readable {
  const child = spawn('git', [...args], { cwd: repo, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.once('close', (code) => {
    if (code !== 0) child.stdout.destroy(new Error(`git ${args[0]} failed (${code ?? 'signal'}): ${stderr.trim()}`));
  });
  return child.stdout;
}

async function collectText(stream: Readable): Promise<string> {
  let output = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) output += chunk;
  return output;
}

async function writeJsonLines(path: string, values: unknown[]): Promise<void> {
  const output = createWriteStream(path, { encoding: 'utf8' });
  for (const value of values) {
    if (!output.write(`${JSON.stringify(value)}\n`)) await once(output, 'drain');
  }
  output.end();
  await once(output, 'finish');
}

function emptyRejections(): Record<RejectionReason, number> {
  return {
    message: 0,
    bot: 0,
    'source-file-count': 0,
    'changed-lines': 0,
    'whitespace-only': 0,
    'missing-at-h': 0,
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  void main();
}

async function main(): Promise<void> {
  const config = loadBenchConfig(resolve(benchDir, 'bench.config.json'));
  const repo = resolve(benchDir, 'repo');
  const commits = await readCommits(resolve(benchDir, 'data', 'commits.jsonl'));
  const result = filterCommits(
    commits,
    await filesAtRevision(repo, config.pinnedSha),
    await whitespaceStats(repo, config.pinnedSha),
  );
  const output = resolve(benchDir, 'data', 'candidates.jsonl');
  await writeJsonLines(output, result.candidates);
  process.stdout.write(`Kept ${result.candidates.length}/${commits.length} commits\n`);
  for (const [reason, count] of Object.entries(result.rejected)) process.stdout.write(`  ${reason}: ${count}\n`);
  process.stdout.write(`Wrote ${output}\n`);
}
