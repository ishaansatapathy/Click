import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { fixtureStream, parseNameStatusRecords, parseNumstatRecords } from './mine-commits.js';

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('git log stream parsers', () => {
  it('parses metadata, regular changes, and renames across small chunks', async () => {
    const records = await collect(parseNameStatusRecords(fixtureStream(resolve(fixtureDir, 'git-log-name-status.txt'), 7)));
    expect(records).toEqual([
      {
        sha: '1111111111111111111111111111111111111111',
        date: '2026-01-02T03:04:05+00:00',
        authorName: 'Ada Lovelace',
        authorEmail: 'ada@example.test',
        message: 'Add dashboard\n\nIncludes the first widgets.',
        files: [
          { status: 'A', path: 'src/Dashboard.vue' },
          { status: 'R095', oldPath: 'src/old.ts', path: 'src/new.ts' },
        ],
      },
      {
        sha: '2222222222222222222222222222222222222222',
        date: '2026-01-01T00:00:00+00:00',
        authorName: 'Grace Hopper',
        authorEmail: 'grace@example.test',
        message: 'Fix store',
        files: [{ status: 'M', path: 'src/store.ts' }],
      },
    ]);
  });

  it('parses numeric and binary numstat values', async () => {
    const records = await collect(parseNumstatRecords(fixtureStream(resolve(fixtureDir, 'git-log-numstat.txt'), 5)));
    expect(records).toEqual([
      {
        sha: '1111111111111111111111111111111111111111',
        stats: [
          { insertions: 12, deletions: 0 },
          { insertions: 2, deletions: 1 },
        ],
      },
      {
        sha: '2222222222222222222222222222222222222222',
        stats: [{ insertions: null, deletions: null }],
      },
    ]);
  });
});

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}
