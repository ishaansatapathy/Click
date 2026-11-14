import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Readable } from 'node:stream';

import { loadBenchConfig } from './fetch-repo.js';

const RECORD_SEPARATOR = '\x1e';
const FIELD_SEPARATOR = '\x1f';
const LOG_FORMAT = `${RECORD_SEPARATOR}%H${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%ae${FIELD_SEPARATOR}%B${FIELD_SEPARATOR}`;

export interface ChangedFile {
  status: string;
  path: string;
  oldPath?: string;
  insertions: number | null;
  deletions: number | null;
}

export interface MinedCommit {
  sha: string;
  date: string;
  authorName: string;
  authorEmail: string;
  message: string;
  files: ChangedFile[];
}

interface NameStatusCommit extends Omit<MinedCommit, 'files'> {
  files: Omit<ChangedFile, 'insertions' | 'deletions'>[];
}

interface NumstatCommit {
  sha: string;
  stats: { insertions: number | null; deletions: number | null }[];
}

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function mineCommits(repo: string, beforeSha: string): Promise<MinedCommit[]> {
  const revision = `${beforeSha}^`;
  const common = ['log', '--no-merges', '-M', `--format=${LOG_FORMAT}`, revision];
  const names = await collect(parseNameStatusRecords(spawnGit(repo, [...common, '--name-status'])));
  const stats = await collect(parseNumstatRecords(spawnGit(repo, [...common, '--numstat'])));
  if (names.length !== stats.length) {
    throw new Error(`Git history streams disagree: ${names.length} name-status records vs ${stats.length} numstat records`);
  }
  return names.map((commit, index) => mergeCommit(commit, stats[index]!));
}

export async function* parseNameStatusRecords(chunks: AsyncIterable<string | Buffer>): AsyncGenerator<NameStatusCommit> {
  for await (const record of splitRecords(chunks)) {
    const parsed = parseHeader(record);
    const files: NameStatusCommit['files'] = [];
    for (const line of parsed.body.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [status, firstPath, secondPath] = line.split('\t');
      if (!status || !firstPath) continue;
      if (status.startsWith('R') || status.startsWith('C')) {
        if (!secondPath) throw new Error(`Malformed rename in ${parsed.sha}: ${line}`);
        files.push({ status, oldPath: firstPath, path: secondPath });
      } else {
        files.push({ status, path: firstPath });
      }
    }
    yield { ...parsed.header, files };
  }
}

export async function* parseNumstatRecords(chunks: AsyncIterable<string | Buffer>): AsyncGenerator<NumstatCommit> {
  for await (const record of splitRecords(chunks)) {
    const parsed = parseHeader(record);
    const stats: NumstatCommit['stats'] = [];
    for (const line of parsed.body.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [insertions, deletions, path] = line.split('\t');
      if (insertions === undefined || deletions === undefined || path === undefined) continue;
      stats.push({
        insertions: insertions === '-' ? null : Number.parseInt(insertions, 10),
        deletions: deletions === '-' ? null : Number.parseInt(deletions, 10),
      });
    }
    yield { sha: parsed.sha, stats };
  }
}

async function* splitRecords(chunks: AsyncIterable<string | Buffer>): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += chunk.toString();
    const records = buffer.split(RECORD_SEPARATOR);
    buffer = records.pop() ?? '';
    for (const record of records) if (record.trim()) yield record;
  }
  if (buffer.trim()) yield buffer;
}

function parseHeader(record: string): {
  sha: string;
  header: Omit<NameStatusCommit, 'files'>;
  body: string;
} {
  const fields = record.split(FIELD_SEPARATOR);
  if (fields.length < 6) throw new Error(`Malformed git log record: ${record.slice(0, 120)}`);
  const [sha = '', date = '', authorName = '', authorEmail = '', message = '', ...body] = fields;
  if (!/^[a-f0-9]{40}$/i.test(sha.trim())) throw new Error(`Malformed commit SHA: ${sha.trim()}`);
  return {
    sha: sha.trim(),
    header: {
      sha: sha.trim(),
      date: date.trim(),
      authorName: authorName.trim(),
      authorEmail: authorEmail.trim(),
      message: message.trim(),
    },
    body: body.join(FIELD_SEPARATOR).trim(),
  };
}

function mergeCommit(names: NameStatusCommit, stats: NumstatCommit): MinedCommit {
  if (names.sha !== stats.sha) throw new Error(`Git history streams out of order: ${names.sha} vs ${stats.sha}`);
  if (names.files.length !== stats.stats.length) {
    throw new Error(`Git diff streams disagree for ${names.sha}: ${names.files.length} files vs ${stats.stats.length} stats`);
  }
  return {
    ...names,
    files: names.files.map((file, index) => ({ ...file, ...stats.stats[index]! })),
  };
}

function spawnGit(repo: string, args: readonly string[]): Readable {
  const child = spawn('git', [...args], { cwd: repo, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.once('close', (code) => {
    if (code !== 0) child.stdout.destroy(new Error(`git ${args[0]} failed (${code ?? 'signal'}): ${stderr.trim()}`));
  });
  return child.stdout;
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

async function writeJsonLines(path: string, commits: MinedCommit[]): Promise<void> {
  const output = createWriteStream(path, { encoding: 'utf8' });
  for (const commit of commits) {
    if (!output.write(`${JSON.stringify(commit)}\n`)) await once(output, 'drain');
  }
  output.end();
  await once(output, 'finish');
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const config = loadBenchConfig(resolve(benchDir, 'bench.config.json'));
  const commits = await mineCommits(resolve(benchDir, 'repo'), config.pinnedSha);
  const output = resolve(benchDir, 'data', 'commits.jsonl');
  await writeJsonLines(output, commits);
  process.stdout.write(`Wrote ${commits.length} non-merge commits before H to ${output}\n`);
}

// Referenced by parser-fixture tests without buffering via readFile.
export function fixtureStream(path: string, highWaterMark = 17): Readable {
  return createReadStream(path, { highWaterMark });
}
