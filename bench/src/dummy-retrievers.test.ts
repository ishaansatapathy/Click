import { describe, expect, it } from 'vitest';

import { countTokens } from '../../packages/core/src/util/tokens.js';
import type { BenchTask } from './task.js';
import {
  emptyRetriever,
  oracleRetriever,
  packFiles,
  randomRetriever,
  type BaselineRepo,
} from './dummy-retrievers.js';

const files: Record<string, string> = {
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': 'export const b = 2;\n',
  'src/c.ts': 'export const c = 3;\n',
};
const repo: BaselineRepo = {
  async listSourceFiles() { return Object.keys(files); },
  async readFile(path) { return files[path] ?? ''; },
};
const task: BenchTask = {
  id: 'h-01', source: 'hand', text: 'Change two behaviors.', type: 'multi-file',
  groundTruth: { files: ['src/b.ts', 'src/a.ts'], symbols: [] }, split: 'test', e2e: false,
};

describe('dummy retrievers', () => {
  it('returns a valid empty floor context', async () => {
    const result = await emptyRetriever()(task, 4_000);
    expect(result).toMatchObject({ variant: 'empty', items: [], text: '', tokens: 0, budget: 4_000 });
  });

  it('selects random source files deterministically for a task and seed', async () => {
    const first = await randomRetriever(repo, 7)(task, 4_000);
    const second = await randomRetriever(repo, 7)(task, 4_000);
    expect(first.items.map((item) => item.path)).toEqual(second.items.map((item) => item.path));
    expect(new Set(first.items.map((item) => item.path))).toEqual(new Set(Object.keys(files)));
    expect((await randomRetriever(repo, 8)(task, 4_000)).configHash).not.toBe(first.configHash);
  });

  it('packs oracle ground-truth files first as whole-file items', async () => {
    const result = await oracleRetriever(repo)(task, 4_000);
    expect(result.items.map((item) => [item.path, item.mode])).toEqual([
      ['src/b.ts', 'file'], ['src/a.ts', 'file'],
    ]);
  });

  it('re-counts rendered output and never exceeds the budget', async () => {
    const large = 'const longName = "lots of tokens";\n'.repeat(100);
    const small = 'export const ok = true;\n';
    const budget = countTokens(`### src/small.ts\n\`\`\`ts\n${small}\`\`\`\n`);
    const result = await packFiles('h-01', 'oracle', budget, ['src/large.ts', 'src/small.ts'], {
      async readFile(path) { return path.includes('large') ? large : small; },
    });
    expect(result.items.map((item) => item.path)).toEqual(['src/small.ts']);
    expect(result.tokens).toBeLessThanOrEqual(budget);
  });
});
