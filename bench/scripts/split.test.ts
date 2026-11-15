import { describe, expect, it } from 'vitest';

import type { ClassifiedCandidate } from './classify.js';
import { splitCandidates, toBenchTask } from './split.js';

function candidate(index: number, sha = `${index}`.padStart(40, '0')): ClassifiedCandidate {
  return {
    sha,
    date: new Date(Date.UTC(2020, 0, index + 1)).toISOString(),
    authorName: 'author',
    authorEmail: 'author@example.com',
    message: 'message',
    files: [],
    groundTruthFiles: ['src/a.ts'],
    changedLines: 1,
    groundTruthSymbols: ['sym:src/a.ts#a'],
    signatureChangedSymbols: [],
    text: 'Do the thing.',
    type: 'single-file',
  };
}

describe('temporal benchmark split', () => {
  it('puts the oldest floor(70%) in train regardless of input order', () => {
    const candidates = Array.from({ length: 10 }, (_, index) => candidate(index)).reverse();
    const split = splitCandidates(candidates);
    expect([...split.values()].filter((value) => value === 'train')).toHaveLength(7);
    expect(split.get(candidate(0).sha)).toBe('train');
    expect(split.get(candidate(9).sha)).toBe('test');
  });

  it('materializes a verified e2e task with its copied-check contract', () => {
    const item = candidate(9, `${'f74fe7b'}${'0'.repeat(33)}`);
    item.groundTruthFiles = ['src/login.vue', 'src/guard.ts'];
    const task = toBenchTask(item, 'test', 'b'.repeat(40));
    expect(task.e2e).toBe(true);
    expect(task.check).toEqual({ kind: 'vue-tsc+vitest', tests: ['bench/e2e/checks/m-f74fe7b.test.ts'] });
    expect(task.groundTruth).toEqual({ files: item.groundTruthFiles, symbols: item.groundTruthSymbols });
  });

  it('rejects an e2e task outside the held-out split', () => {
    const item = candidate(9, `${'caa9c84'}${'0'.repeat(33)}`);
    expect(() => toBenchTask(item, 'train', 'b'.repeat(40))).toThrow(/held-out\/size/);
  });
});
