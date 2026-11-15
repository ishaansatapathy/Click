import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, extname, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

import { DiskCache } from '../../packages/core/src/util/diskCache.js';
import {
  TASK_TEXT_SYSTEM_PROMPT,
  generateTaskTexts,
  loadTaskTextEnv,
  taskTextRuntimeFromEnv,
  type TaskTextRecord,
} from './write-task-text.js';

export const LEAK_RETRY_PROMPT_VERSION = 'task-text-v1-leak-v1';
const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface LeakCheckResult {
  records: TaskTextRecord[];
  before: number;
  after: number;
  rejectedShas: string[];
}

export function forbiddenTerms(paths: readonly string[]): string[] {
  const terms = new Set<string>();
  for (const path of paths) {
    for (const segment of path.split(/[\\/]/).filter(Boolean)) terms.add(segment);
    const file = parse(path).base;
    const stem = parse(path).name;
    terms.add(file);
    terms.add(stem);
    if (extname(path).toLowerCase() === '.vue') {
      const words = splitName(stem);
      terms.add(words.map(capitalise).join(''));
      terms.add(words.join('-'));
    }
  }
  return [...terms].filter(Boolean).sort((a, b) => b.length - a.length || a.localeCompare(b));
}

export function findLeaks(record: Pick<TaskTextRecord, 'text' | 'groundTruthFiles'>): string[] {
  const lower = record.text.toLocaleLowerCase('en-US');
  return forbiddenTerms(record.groundTruthFiles).filter((term) => lower.includes(term.toLocaleLowerCase('en-US')));
}

export async function checkLeaks(
  records: TaskTextRecord[],
  regenerate: (record: TaskTextRecord, forbidden: string[]) => Promise<TaskTextRecord>,
): Promise<LeakCheckResult> {
  const initial = records.map((record) => ({ record, leaks: findLeaks(record) }));
  const before = initial.filter(({ leaks }) => leaks.length > 0).length;
  const updated = await Promise.all(initial.map(async ({ record, leaks }) => leaks.length ? regenerate(record, leaks) : record));
  const rejectedShas = updated.filter((record) => findLeaks(record).length > 0).map((record) => record.sha);
  return { records: updated, before, after: rejectedShas.length, rejectedShas };
}

export function stricterSystemPrompt(terms: readonly string[]): string {
  return `${TASK_TEXT_SYSTEM_PROMPT}\nThis retry previously leaked repository vocabulary. Do not use any of these strings or close case/style variants: ${terms.join(', ')}.`;
}

function splitName(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .split(/[-_\s]+/)
    .map((part) => part.toLowerCase())
    .filter(Boolean);
}

function capitalise(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

async function readTaskTexts(path: string): Promise<TaskTextRecord[]> {
  const records: TaskTextRecord[] = [];
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) records.push(JSON.parse(line) as TaskTextRecord);
  return records;
}

async function writeJsonLines(path: string, values: unknown[]): Promise<void> {
  const output = createWriteStream(path, { encoding: 'utf8' });
  for (const value of values) if (!output.write(`${JSON.stringify(value)}\n`)) await once(output, 'drain');
  output.end();
  await once(output, 'finish');
}

async function mergeRejected(path: string, shas: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let existing = '';
  try { existing = await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const values = new Set([...existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean), ...shas]);
  await writeFile(path, values.size ? `${[...values].sort().join('\n')}\n` : '', 'utf8');
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) void main();

async function main(): Promise<void> {
  loadTaskTextEnv();
  const input = resolve(benchDir, 'data', 'task-texts.jsonl');
  const records = await readTaskTexts(input);
  const runtime = taskTextRuntimeFromEnv();
  const result = await checkLeaks(records, async (record, terms) => {
    const generated = await generateTaskTexts([record], {
      repo: resolve(benchDir, 'repo'),
      cache: new DiskCache('llm'),
      ...runtime,
      promptVersion: LEAK_RETRY_PROMPT_VERSION,
      systemPrompt: stricterSystemPrompt(terms),
    });
    return generated.records[0]!;
  });
  await writeJsonLines(input, result.records);
  await mergeRejected(resolve(benchDir, 'tasks', 'rejected.txt'), result.rejectedShas);
  const total = result.records.length || 1;
  process.stdout.write(`Leak rate before: ${result.before}/${result.records.length} (${(100 * result.before / total).toFixed(2)}%)\n`);
  process.stdout.write(`Leak rate after: ${result.after}/${result.records.length} (${(100 * result.after / total).toFixed(2)}%)\n`);
  process.stdout.write(`Rejected after one retry: ${result.rejectedShas.length}\n`);
}
