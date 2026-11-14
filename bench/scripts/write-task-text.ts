import Anthropic from '@anthropic-ai/sdk';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

import { DiskCache } from '../../packages/core/src/util/diskCache.js';
import { hashOf } from '../../packages/core/src/util/hash.js';
import { countTokens } from '../../packages/core/src/util/tokens.js';
import type { CandidateCommit } from './filter-commits.js';
import { spawnGit } from './fetch-repo.js';

export const TASK_TEXT_MODEL = 'claude-haiku-5-5';
export const TASK_TEXT_PROMPT_VERSION = 'task-text-v1';
export const TASK_TEXT_CONCURRENCY = 4;
export const MAX_DIFF_TOKENS = 3_000;

const INPUT_USD_PER_MILLION = 0.1;
const OUTPUT_USD_PER_MILLION = 0.5;
const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface MessageResponse {
  content: { type: string; text?: string }[];
  usage: { input_tokens: number | null; output_tokens: number };
}

export interface MessageClient {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      temperature: number;
      system: string;
      messages: { role: 'user'; content: string }[];
    }): Promise<MessageResponse>;
  };
}

export interface TaskTextRecord extends CandidateCommit {
  text: string;
  taskText: {
    model: string;
    promptVersion: string;
    inputTokens: number;
    outputTokens: number;
  };
}

export interface GenerationSummary {
  records: TaskTextRecord[];
  cacheHits: number;
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

interface GenerateOptions {
  repo: string;
  cache: DiskCache;
  client?: MessageClient;
  concurrency?: number;
  git?: typeof spawnGit;
  sleep?: (milliseconds: number) => Promise<void>;
  promptVersion?: string;
  systemPrompt?: string;
}

export async function generateTaskTexts(
  candidates: CandidateCommit[],
  options: GenerateOptions,
): Promise<GenerationSummary> {
  const promptVersion = options.promptVersion ?? TASK_TEXT_PROMPT_VERSION;
  const stats = { cacheHits: 0, apiCalls: 0, inputTokens: 0, outputTokens: 0 };
  const records = await mapLimit(candidates, options.concurrency ?? TASK_TEXT_CONCURRENCY, async (candidate) => {
    const cacheKey = hashOf({ sha: candidate.sha, promptVersion });
    const hit = await options.cache.get<TaskTextRecord['taskText'] & { text: string }>(cacheKey);
    if (hit) {
      stats.cacheHits++;
      return toRecord(candidate, hit);
    }
    if (!options.client) throw new Error('ANTHROPIC_API_KEY is required for uncached task text');

    const git = options.git ?? spawnGit;
    const [diffStat, rawDiff] = await Promise.all([
      git(['show', '--format=', '--stat', '--no-ext-diff', candidate.sha, '--'], options.repo),
      git(['show', '--format=', '--unified=3', '--no-ext-diff', candidate.sha, '--'], options.repo),
    ]);
    const prompt = buildTaskPrompt(candidate.message, diffStat, truncateTokens(rawDiff, MAX_DIFF_TOKENS));
    const response = await withBackoff(
      () => options.client!.messages.create({
        model: TASK_TEXT_MODEL,
        max_tokens: 180,
        temperature: 0,
        system: options.systemPrompt ?? TASK_TEXT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      }),
      options.sleep,
    );
    const text = response.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('').trim();
    if (!text) throw new Error(`Anthropic returned no task text for ${candidate.sha}`);
    const value = {
      text,
      model: TASK_TEXT_MODEL,
      promptVersion,
      inputTokens: response.usage.input_tokens ?? 0,
      outputTokens: response.usage.output_tokens,
    };
    await options.cache.set(cacheKey, value);
    stats.apiCalls++;
    stats.inputTokens += value.inputTokens;
    stats.outputTokens += value.outputTokens;
    return toRecord(candidate, value);
  });

  return {
    records,
    ...stats,
    estimatedCostUsd:
      (stats.inputTokens * INPUT_USD_PER_MILLION + stats.outputTokens * OUTPUT_USD_PER_MILLION) / 1_000_000,
  };
}

export const TASK_TEXT_SYSTEM_PROMPT = `Turn a historical commit into a plausible developer task request.
Write 1-3 concise sentences in the developer's voice and describe intent, not implementation.
Never mention paths, file names, extensions, directories, line numbers, commits, diffs, or patches.
Only use a code symbol name when that exact symbol appears in the commit message.
Return task text only, without a label, quotation marks, or commentary.`;

export function buildTaskPrompt(commitMessage: string, diffStat: string, diff: string): string {
  return `Commit message:\n${commitMessage.trim()}\n\nDiff stat:\n${diffStat.trim()}\n\nDiff (truncated):\n${diff}`;
}

export function truncateTokens(text: string, limit: number): string {
  if (countTokens(text) <= limit) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (countTokens(text.slice(0, middle)) <= limit) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

export async function withBackoff<T>(
  operation: () => Promise<T>,
  sleep: (milliseconds: number) => Promise<void> = delay,
  attempts = 4,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt + 1 >= attempts || !isRetryable(error)) throw error;
      await sleep(250 * (2 ** attempt));
    }
  }
}

function isRetryable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = 'status' in error && typeof error.status === 'number' ? error.status : undefined;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  return status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500)
    || ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND'].includes(code);
}

async function mapLimit<T, U>(items: T[], limit: number, task: (item: T) => Promise<U>): Promise<U[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`Invalid concurrency: ${limit}`);
  const results = new Array<U>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function toRecord(candidate: CandidateCommit, value: TaskTextRecord['taskText'] & { text: string }): TaskTextRecord {
  const { text, ...taskText } = value;
  return { ...candidate, text, taskText };
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function readCandidates(path: string): Promise<CandidateCommit[]> {
  const values: CandidateCommit[] = [];
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) values.push(JSON.parse(line) as CandidateCommit);
  return values;
}

async function writeJsonLines(path: string, values: unknown[]): Promise<void> {
  const output = createWriteStream(path, { encoding: 'utf8' });
  for (const value of values) if (!output.write(`${JSON.stringify(value)}\n`)) await once(output, 'drain');
  output.end();
  await once(output, 'finish');
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) void main();

async function main(): Promise<void> {
  const candidates = await readCandidates(resolve(benchDir, 'data', 'candidates.jsonl'));
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const client = apiKey ? new Anthropic({ apiKey, maxRetries: 0, timeout: 60_000 }) as MessageClient : undefined;
  const summary = await generateTaskTexts(candidates, {
    repo: resolve(benchDir, 'repo'),
    cache: new DiskCache('llm'),
    client,
  });
  const output = resolve(benchDir, 'data', 'task-texts.jsonl');
  await writeJsonLines(output, summary.records);
  process.stdout.write(`Wrote ${summary.records.length} tasks to ${output}\n`);
  process.stdout.write(`Cache hits: ${summary.cacheHits}; API calls: ${summary.apiCalls}\n`);
  process.stdout.write(`API tokens: ${summary.inputTokens} input, ${summary.outputTokens} output\n`);
  process.stdout.write(`Estimated API cost: $${summary.estimatedCostUsd.toFixed(6)}\n`);
}
