import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changedPaths, parseNameStatusZ, parsePorcelainZ } from './changed.js';

let root: string;
const git = (...args: string[]) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const put = (rel: string, text = 'x\n') => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const commit = (msg: string) => {
  git('add', '-A');
  git('-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-q', '-m', msg);
};
const summary = async (since?: string | null, r = root) => {
  const res = await changedPaths(r, since);
  if (!res.ok) throw new Error(res.reason);
  return res.changes.map((c) => `${c.status}:${c.path}`);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'click-changed-'));
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  put('a.ts');
  put('b.ts');
  put('c.ts');
  put('src/my file.ts'); // spaces
  put('src/cafè.ts'); // non-ASCII
  commit('base');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('changedPaths (PROMPTS 059)', () => {
  let base: string;
  beforeAll(() => {
    base = git('rev-parse', 'HEAD');
  });

  it('a clean tree has no changes', async () => {
    expect(await summary(base)).toEqual([]);
    expect(await summary(null)).toEqual([]);
  });

  it('committed + uncommitted changes since a commit; renames become delete + add; the file system decides the status', async () => {
    put('a.ts', 'changed\n'); // modified + committed
    unlinkSync(join(root, 'b.ts')); // deleted + committed
    renameSync(join(root, 'c.ts'), join(root, 'd.ts')); // renamed + committed
    put('src/my file.ts', 'edited\n');
    put('src/cafè.ts', 'edited\n');
    commit('edits');
    put('new.ts'); // untracked
    put('a.ts', 'changed again\n'); // modified, uncommitted
    unlinkSync(join(root, 'src/my file.ts')); // deleted, uncommitted
    put('added-then-deleted.ts');
    git('add', 'added-then-deleted.ts');
    unlinkSync(join(root, 'added-then-deleted.ts')); // staged add, gone from disk

    expect(await summary(base)).toEqual([
      'M:a.ts',
      'D:added-then-deleted.ts',
      'D:b.ts',
      'D:c.ts',
      'M:d.ts',
      'M:new.ts',
      'M:src/cafè.ts',
      'D:src/my file.ts',
    ]);
  });

  it('without a base commit only the working tree counts', async () => {
    expect(await summary(null)).toEqual(['M:a.ts', 'D:added-then-deleted.ts', 'M:new.ts', 'D:src/my file.ts']);
  });

  it('an unknown commit is reported, not thrown', async () => {
    expect(await changedPaths(root, '0123456789abcdef0123456789abcdef01234567')).toMatchObject({ ok: false, reason: 'unknown-commit' });
  });

  it('a directory that is not a git repo is reported, not thrown', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'click-nogit-'));
    try {
      expect(await changedPaths(plain, null)).toMatchObject({ ok: false, reason: 'not-a-git-repo' });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('works when root is a subdirectory of the repo: paths are relative to root, others are ignored', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'click-sub-'));
    const sh = (...a: string[]) => {
      const r = spawnSync('git', a, { cwd: outer, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    try {
      sh('init', '-q');
      mkdirSync(join(outer, 'app/src'), { recursive: true });
      mkdirSync(join(outer, 'other'), { recursive: true });
      writeFileSync(join(outer, 'app/src/x.ts'), '1');
      writeFileSync(join(outer, 'other/y.ts'), '1');
      sh('add', '-A');
      sh('-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-q', '-m', 'init');
      const since = sh('rev-parse', 'HEAD');
      writeFileSync(join(outer, 'app/src/x.ts'), '2');
      writeFileSync(join(outer, 'app/src/z.ts'), '1');
      writeFileSync(join(outer, 'other/y.ts'), '2');
      sh('add', '-A');
      sh('-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-q', '-m', 'more');
      writeFileSync(join(outer, 'app/new.ts'), '1');
      expect(await summary(since, join(outer, 'app'))).toEqual(['M:new.ts', 'M:src/x.ts', 'M:src/z.ts']);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});

describe('parsers', () => {
  it('parseNameStatusZ handles plain and rename/copy records', () => {
    expect(parseNameStatusZ('M\0a.ts\0D\0b.ts\0R100\0old.ts\0new.ts\0A\0c.ts\0')).toEqual([
      { status: 'M', path: 'a.ts' },
      { status: 'D', path: 'b.ts' },
      { status: 'R100', path: 'new.ts', oldPath: 'old.ts' },
      { status: 'A', path: 'c.ts' },
    ]);
  });
  it('parsePorcelainZ handles modified, untracked and renamed (new path first, then old)', () => {
    expect(parsePorcelainZ(' M a.ts\0?? n.ts\0R  new.ts\0old.ts\0 D gone.ts\0')).toEqual([
      { xy: ' M', path: 'a.ts' },
      { xy: '??', path: 'n.ts' },
      { xy: 'R ', path: 'new.ts', oldPath: 'old.ts' },
      { xy: ' D', path: 'gone.ts' },
    ]);
  });
});
