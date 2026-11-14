import { describe, expect, it } from 'vitest';

import { buildFuturePathMap, filterCommits } from './filter-commits.js';
import type { ChangedFile, MinedCommit } from './mine-commits.js';

describe('buildFuturePathMap', () => {
  it('follows rename chains forward to H', () => {
    const commits = [
      commit('3', [{ status: 'R100', oldPath: 'src/middle.ts', path: 'src/current.ts' }]),
      commit('2', [{ status: 'R100', oldPath: 'src/old.ts', path: 'src/middle.ts' }]),
    ];
    const paths = buildFuturePathMap(commits, new Set(['src/current.ts']));
    expect(paths.get('src/old.ts')).toBe('src/current.ts');
  });
});

describe('filterCommits', () => {
  it('keeps valid source commits and translates renamed ground truth', () => {
    const valid = commit('1', [{ status: 'M', path: 'src/old.ts', insertions: 4, deletions: 2 }]);
    const rename = commit('2', [{ status: 'R100', oldPath: 'src/old.ts', path: 'src/current.ts' }]);
    const result = filterCommits([rename, valid], new Set(['src/current.ts']), new Map([[rename.sha, 1], [valid.sha, 6]]));
    expect(result.candidates.map((item) => item.groundTruthFiles)).toEqual([
      ['src/current.ts'],
      ['src/current.ts'],
    ]);
  });

  it('reports each rejection reason deterministically', () => {
    const commits = [
      commit('1', [{ status: 'M', path: 'src/a.ts' }], { message: 'chore: deps' }),
      commit('2', [{ status: 'M', path: 'src/a.ts' }], { authorName: 'dependabot[bot]' }),
      commit('3', [{ status: 'M', path: 'README.md' }]),
      commit('4', [{ status: 'M', path: 'src/a.ts', insertions: 401 }]),
      commit('5', [{ status: 'M', path: 'src/a.ts' }]),
      commit('6', [{ status: 'M', path: 'src/deleted.ts' }]),
    ];
    const whitespace = new Map(commits.map((item) => [item.sha, item.sha === commits[4]!.sha ? 0 : 1]));
    const result = filterCommits(commits, new Set(['src/a.ts']), whitespace);
    expect(result.candidates).toHaveLength(0);
    expect(result.rejected).toEqual({
      message: 1,
      bot: 1,
      'source-file-count': 1,
      'changed-lines': 1,
      'whitespace-only': 1,
      'missing-at-h': 1,
    });
  });
});

function commit(
  digit: string,
  files: (Pick<ChangedFile, 'status' | 'path'> & Partial<ChangedFile>)[],
  overrides: Partial<MinedCommit> = {},
): MinedCommit {
  return {
    sha: digit.repeat(40),
    date: '2026-01-01T00:00:00Z',
    authorName: 'Developer',
    authorEmail: 'dev@example.test',
    message: 'feat: useful change',
    files: files.map((file) => ({
      ...file,
      insertions: file.insertions ?? 1,
      deletions: file.deletions ?? 0,
    })),
    ...overrides,
  };
}
