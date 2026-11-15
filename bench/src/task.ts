import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { z } from 'zod';

import { buildIndex } from '../../packages/core/src/indexer/build.js';
import { loadBenchConfig, spawnGit } from '../scripts/fetch-repo.js';

const sha = z.string().regex(/^[a-f0-9]{40}$/i, 'must be a full Git SHA');
const repoPath = z.string().min(1).refine(isRepoPath, 'must be a POSIX repo-relative path');
const nodeId = z.string().min(1).refine(isNodeId, 'must use a SPEC §2.1 node ID');

export const benchTaskSchema = z.object({
  id: z.string().min(1),
  source: z.enum(['mined', 'hand']),
  commit: sha.optional(),
  parentCommit: sha.optional(),
  date: z.iso.datetime({ offset: true }).optional(),
  text: z.string().trim().min(1),
  type: z.enum(['single-file', 'multi-file', 'multi-hop', 'impact', 'convention']),
  groundTruth: z.object({
    files: z.array(repoPath).min(1),
    symbols: z.array(nodeId),
  }),
  split: z.enum(['train', 'test']),
  e2e: z.boolean(),
  check: z.object({
    kind: z.literal('vue-tsc+vitest'),
    tests: z.array(repoPath).min(1),
  }).optional(),
}).strict().superRefine((task, context) => {
  const expected = task.source === 'mined' ? /^m-[a-f0-9]{7}$/i : /^h-\d{2}$/;
  if (!expected.test(task.id)) {
    context.addIssue({ code: 'custom', path: ['id'], message: `invalid ${task.source} task ID` });
  }
  if (task.source === 'mined' && task.commit && task.id.slice(2).toLowerCase() !== task.commit.slice(0, 7).toLowerCase()) {
    context.addIssue({ code: 'custom', path: ['id'], message: 'mined task ID must match the commit SHA prefix' });
  }
  for (const [field, values] of Object.entries(task.groundTruth)) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', path: ['groundTruth', field], message: 'must not contain duplicates' });
    }
  }
});

export type BenchTask = z.infer<typeof benchTaskSchema>;

export interface ValidationResult {
  tasks: BenchTask[];
  rejected: number;
  errors: string[];
}

export function taskCommitShas(tasks: readonly BenchTask[]): string[] {
  return [...new Set(tasks.flatMap((task) => task.commit ? [task.commit] : []))].sort();
}

export function taskCommitFileError(tasks: readonly BenchTask[], contents: string): string | null {
  const expected = taskCommitShas(tasks);
  const actual = contents.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return expected.length === actual.length && expected.every((shaValue, index) => shaValue === actual[index])
    ? null
    : `bench/data/task-commits.txt is stale: expected ${expected.length} sorted accepted task SHA(s), found ${actual.length}`;
}

export function validateTasks(
  values: { value: unknown; origin: string }[],
  filesAtH: ReadonlySet<string>,
  nodeIdsAtH: ReadonlySet<string>,
  rejectedValues: ReadonlySet<string>,
): ValidationResult {
  const tasks: BenchTask[] = [];
  const errors: string[] = [];
  let rejected = 0;

  for (const { value, origin } of values) {
    const parsed = benchTaskSchema.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors.push(`${origin}: ${issue.path.join('.') || '<root>'}: ${issue.message}`);
      continue;
    }
    const task = parsed.data;
    if (isRejected(task, rejectedValues)) { rejected++; continue; }
    tasks.push(task);
  }

  const seen = new Map<string, number>();
  for (const task of tasks) seen.set(task.id, (seen.get(task.id) ?? 0) + 1);
  for (const [id, count] of seen) if (count > 1) errors.push(`duplicate task ID: ${id} (${count} occurrences)`);

  for (const task of tasks) {
    for (const path of task.groundTruth.files) {
      if (!filesAtH.has(path)) errors.push(`${task.id}: ground-truth file does not exist at H: ${path}`);
    }
    for (const id of task.groundTruth.symbols) {
      if (!nodeIdsAtH.has(id)) errors.push(`${task.id}: ground-truth symbol does not exist at H: ${id}`);
    }
  }
  return { tasks, rejected, errors };
}

export async function loadTaskValues(root: string): Promise<{ value: unknown; origin: string }[]> {
  const paths = await taskFiles(root);
  const values: { value: unknown; origin: string }[] = [];
  for (const path of paths) {
    if (extname(path) === '.jsonl') {
      const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
      let lineNumber = 0;
      for await (const line of lines) {
        lineNumber++;
        if (!line.trim()) continue;
        try { values.push({ value: JSON.parse(line), origin: `${path}:${lineNumber}` }); }
        catch (error) { values.push({ value: { invalidJson: String(error) }, origin: `${path}:${lineNumber}` }); }
      }
    } else {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      entries.forEach((value, index) => values.push({ value, origin: `${path}${entries.length > 1 ? `[${index}]` : ''}` }));
    }
  }
  return values;
}

async function taskFiles(root: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const paths: string[] = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) paths.push(...await taskFiles(path));
    else if (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) paths.push(path);
  }
  return paths.sort();
}

export async function loadRejected(path: string): Promise<Set<string>> {
  try {
    return new Set((await readFile(path, 'utf8')).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
}

export async function validateTaskDirectory(root: string): Promise<ValidationResult> {
  const config = loadBenchConfig(resolve(root, 'bench.config.json'));
  const repo = resolve(root, 'repo');
  const files = new Set((await spawnGit(['ls-tree', '-r', '--name-only', config.pinnedSha], repo)).split(/\r?\n/).filter(Boolean));
  const nodeIds = new Set((await buildIndex(repo)).graph.nodes.map((node) => node.id));
  const values = await loadTaskValues(resolve(root, 'tasks'));
  const result = validateTasks(values, files, nodeIds, await loadRejected(resolve(root, 'tasks', 'rejected.txt')));
  if (values.length === 0) result.errors.push('no benchmark task files found under bench/tasks');
  return result;
}

function isRejected(task: BenchTask, rejected: ReadonlySet<string>): boolean {
  return rejected.has(task.id) || (task.commit !== undefined && (
    rejected.has(task.commit) || rejected.has(task.commit.slice(0, 7)) || rejected.has(`m-${task.commit.slice(0, 7)}`)
  ));
}

function isRepoPath(value: string): boolean {
  return !value.includes('\\') && !value.startsWith('/') && !value.startsWith('./')
    && !/^[A-Za-z]:/.test(value) && !value.split('/').some((part) => !part || part === '.' || part === '..');
}

function isNodeId(value: string): boolean {
  return /^(?:file:[^#]+|sym:[^#]+#[^#]+|route:\/.*|chunk:[^#]+#[^#]+#\d+|conv:[a-z0-9][a-z0-9-]*)$/.test(value);
}

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const result = await validateTaskDirectory(benchDir);
  let taskCommitContents = '';
  try { taskCommitContents = await readFile(resolve(benchDir, 'data', 'task-commits.txt'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const commitError = taskCommitFileError(result.tasks, taskCommitContents);
  if (commitError) result.errors.push(commitError);
  if (result.errors.length) {
    for (const error of result.errors) process.stderr.write(`ERROR ${error}\n`);
    throw new Error(`Benchmark validation failed with ${result.errors.length} error(s)`);
  }
  process.stdout.write(`Validated ${result.tasks.length} task(s); honoured ${result.rejected} rejection(s)\n`);
}
