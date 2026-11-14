import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DiskCache } from '../../packages/core/src/util/diskCache.js';
import type { CandidateCommit } from './filter-commits.js';
import {
  MAX_DIFF_TOKENS,
  TASK_TEXT_CONCURRENCY,
  TASK_TEXT_MODEL,
  generateTaskTexts,
  truncateTokens,
  withBackoff,
  type MessageClient,
} from './write-task-text.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

function candidate(index: number): CandidateCommit {
  return {
    sha: index.toString(16).padStart(40, '0'),
    date: '2025-01-01T00:00:00Z',
    authorName: 'Developer',
    authorEmail: 'dev@example.com',
    message: `Improve search behavior ${index}`,
    files: [{ status: 'M', path: 'src/search.ts', insertions: 2, deletions: 1 }],
    groundTruthFiles: ['src/search.ts'],
    changedLines: 3,
  };
}

async function cache(): Promise<DiskCache> {
  const dir = await mkdtemp(join(tmpdir(), 'click-task-text-'));
  dirs.push(dir);
  return new DiskCache('llm', { dir, cacheOnly: false });
}

describe('generateTaskTexts', () => {
  it('uses the required model and reuses the sha/prompt-version cache', async () => {
    let calls = 0;
    const client: MessageClient = { messages: { create: async (params) => {
      calls++;
      expect(params.model).toBe(TASK_TEXT_MODEL);
      expect(params.temperature).toBe(0);
      return { content: [{ type: 'text', text: 'Please make search results easier to refine.' }], usage: { input_tokens: 20, output_tokens: 8 } };
    } } };
    const options = { repo: 'repo', cache: await cache(), client, git: async () => 'diff body' };
    const first = await generateTaskTexts([candidate(1)], options);
    const second = await generateTaskTexts([candidate(1)], { ...options, client: undefined });

    expect(calls).toBe(1);
    expect(first).toMatchObject({ apiCalls: 1, cacheHits: 0, inputTokens: 20, outputTokens: 8 });
    expect(second).toMatchObject({ apiCalls: 0, cacheHits: 1 });
    expect(second.records[0]?.text).toBe('Please make search results easier to refine.');
  });

  it('limits concurrent LLM calls to four while preserving input order', async () => {
    let active = 0;
    let peak = 0;
    const client: MessageClient = { messages: { create: async (params) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      active--;
      return { content: [{ type: 'text', text: params.messages[0]!.content.match(/behavior (\d+)/)?.[1] ?? 'task' }], usage: { input_tokens: 1, output_tokens: 1 } };
    } } };
    const values = Array.from({ length: 9 }, (_, index) => candidate(index + 1));
    const result = await generateTaskTexts(values, {
      repo: 'repo', cache: await cache(), client, git: async () => 'diff', concurrency: TASK_TEXT_CONCURRENCY,
    });

    expect(peak).toBe(4);
    expect(result.records.map((record) => record.text)).toEqual(values.map((_, index) => String(index + 1)));
  });
});

describe('helpers', () => {
  it('truncates diffs to the proxy-token limit', () => {
    const truncated = truncateTokens('const value = 123;\n'.repeat(2_000), MAX_DIFF_TOKENS);
    expect(truncated.length).toBeLessThan(40_000);
    expect(truncateTokens('short diff', MAX_DIFF_TOKENS)).toBe('short diff');
  });

  it('backs off retryable failures and stops after success', async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await withBackoff(async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('rate limited'), { status: 429 });
      return 'ok';
    }, async (milliseconds) => { waits.push(milliseconds); });
    expect(result).toBe('ok');
    expect(waits).toEqual([250, 500]);
  });
});
