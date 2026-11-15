import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkCommitFiles,
  checkCommits,
  git,
  makeClassifier,
  parseNameStatus,
  readPair,
  run,
  type FileChange,
} from './lib.js';

const classify = makeClassifier();
const m = (path: string): FileChange => ({ status: 'M', path });

describe('classify (PLAN §14.4)', () => {
  it.each([
    ['packages/core/src/types.ts', 'frozen'],
    ['packages/core/src/store/types.ts', 'frozen'],
    ['packages/core/src/contracts.ts', 'frozen'],
    ['package.json', 'shared'],
    ['pnpm-lock.yaml', 'shared'],
    ['packages/core/package.json', 'shared'],
    ['bench/package.json', 'shared'],
    ['packages/core/src/config.ts', 'shared'],
    ['.gitignore', 'shared'],
    ['scripts/pair/sync.ts', 'shared'],
    ['docs/hydradb-notes.md', 'open'],
    ['bench/src/runner.ts', 'laneA'],
    ['bench/scripts/fixtures/x.txt', 'laneA'],
    ['infra/hydradb/docker-compose.yml', 'laneA'],
    ['apps/dashboard/src/main.ts', 'laneA'],
    ['packages/core/src/store/hydradb.ts', 'laneA'],
    ['packages/core/src/retrieve/semantic.ts', 'laneA'],
    ['packages/core/src/retrieve/semantic.test.ts', 'laneA'],
    ['packages/core/src/indexer/profile.ts', 'laneA'],
    ['packages/click/src/mcp/server.ts', 'laneA'],
    ['packages/click/src/install/codex.ts', 'laneA'],
    ['packages/click/src/install/claude-mcp.test.ts', 'laneA'],
    ['packages/click/src/cli/init.ts', 'laneA'],
    ['README.md', 'laneA'],
    ['packages/core/src/indexer/resolve.ts', 'laneB'],
    ['packages/core/src/retrieve/lexical.ts', 'laneB'],
    ['packages/core/src/testing/fakes.ts', 'laneB'],
    ['packages/click/src/install/claude.ts', 'laneB'],
    ['packages/click/src/cli/map.ts', 'laneB'],
    ['packages/core/test/fixtures/mini-vue/src/App.vue', 'laneB'],
    ['random-root-file.txt', 'unowned'],
  ])('%s → %s', (path, cls) => {
    expect(classify(path)).toBe(cls);
  });

  it('normalises Windows paths and ./ prefixes', () => {
    expect(classify('bench\\src\\runner.ts')).toBe('laneA');
    expect(classify('./packages/core/src/types.ts')).toBe('frozen');
  });
});

describe('checkCommitFiles', () => {
  it('allows a seat to change its own lane and open docs', () => {
    expect(checkCommitFiles('a', [m('bench/src/x.ts'), m('docs/notes.md')], 'A/031: x', classify)).toEqual([]);
    expect(checkCommitFiles('b', [m('packages/core/src/graph/ppr.ts')], 'B/088: ppr', classify)).toEqual([]);
  });

  it("blocks the other lane's files", () => {
    const v = checkCommitFiles('a', [m('bench/src/x.ts'), m('packages/core/src/graph/ppr.ts')], 'A/031', classify);
    expect(v.map((x) => x.path)).toEqual(['packages/core/src/graph/ppr.ts']);
    expect(checkCommitFiles('b', [m('bench/src/runner.ts')], 'B/1', classify)).toHaveLength(1);
  });

  it('allows shared files only in a commit of their own', () => {
    expect(checkCommitFiles('a', [m('package.json'), m('pnpm-lock.yaml')], 'deps: add zod', classify)).toEqual([]);
    const mixed = checkCommitFiles('a', [m('package.json'), m('bench/src/x.ts')], 'A/025', classify);
    expect(mixed.map((x) => x.path)).toEqual(['package.json']);
  });

  it('treats unowned paths like shared ones', () => {
    expect(checkCommitFiles('b', [m('new-root.txt')], 'chore', classify)).toEqual([]);
    expect(checkCommitFiles('b', [m('new-root.txt'), m('packages/core/src/a.ts')], 'B/1', classify)).toHaveLength(1);
  });

  it('protects frozen contracts unless the commit is a contract change', () => {
    expect(checkCommitFiles('b', [m('packages/core/src/types.ts')], 'B/090: tweak', classify)).toHaveLength(1);
    expect(checkCommitFiles('b', [m('packages/core/src/types.ts'), m('packages/core/src/pack/pack.ts')], 'contract: add field (req 12)', classify)).toEqual([]);
  });

  it('checks both sides of a rename', () => {
    const rename: FileChange = { status: 'R100', oldPath: 'packages/core/src/graph/x.ts', path: 'bench/src/x.ts' };
    const v = checkCommitFiles('a', [rename], 'A/1', classify);
    expect(v.map((x) => x.path)).toEqual(['packages/core/src/graph/x.ts']);
  });
});

describe('parseNameStatus', () => {
  it('parses adds, modifies, deletes, renames and copies', () => {
    expect(parseNameStatus('A\tnew.ts\nM\tmod.ts\nD\tgone.ts\nR087\told.ts\tnew2.ts\nC100\tsrc.ts\tcopy.ts\n')).toEqual([
      { status: 'A', path: 'new.ts' },
      { status: 'M', path: 'mod.ts' },
      { status: 'D', path: 'gone.ts' },
      { status: 'R087', oldPath: 'old.ts', path: 'new2.ts' },
      { status: 'C100', oldPath: 'src.ts', path: 'copy.ts' },
    ]);
  });
});

describe('checkCommits on a real repo', () => {
  let repo: string;
  const write = (rel: string, text: string) => {
    const full = join(repo, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  };
  const commit = async (msg: string) => {
    await git(['add', '-A'], repo);
    await git(['commit', '-q', '-m', msg], repo);
  };

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'click-pair-'));
    await git(['init', '-q', '-b', 'main'], repo);
    await git(['config', 'user.email', 't@example.com'], repo);
    await git(['config', 'user.name', 'Test'], repo);
    await git(['config', 'core.autocrlf', 'false'], repo);
    write('README.md', 'x');
    await commit('init');
    await git(['checkout', '-q', '-b', 'lane/a'], repo);
    write('bench/src/a.ts', 'a');
    await commit('A/001: own file');
    write('packages/core/src/graph/ppr.ts', 'b');
    await commit('A/002: oops, lane B file');
    write('package.json', '{}');
    await commit('deps: alone is fine');
  }, 30_000);
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('reports only the offending commit, with its sha and subject', async () => {
    const v = await checkCommits('main..lane/a', 'a', repo, classify);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ path: 'packages/core/src/graph/ppr.ts', subject: 'A/002: oops, lane B file' });
    expect(v[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('is clean for an empty range', async () => {
    expect(await checkCommits('lane/a..lane/a', 'a', repo, classify)).toEqual([]);
  });
});

describe('readPair', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'click-pairinfo-'));
    mkdirSync(join(root, 'main', 'coord'), { recursive: true });
    writeFileSync(join(root, 'main', 'coord', 'pair.json'), '{}');
    mkdirSync(join(root, 'wt', 'a', 'bench', 'src'), { recursive: true });
    writeFileSync(join(root, 'wt', 'a', '.pair.json'), JSON.stringify({ seat: 'a', main: join(root, 'main'), worktree: join(root, 'wt', 'a') }));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('finds .pair.json from deep inside a worktree', () => {
    expect(readPair(join(root, 'wt', 'a', 'bench', 'src'))).toEqual({ seat: 'a', main: join(root, 'main'), worktree: join(root, 'wt', 'a') });
  });
  it('recognises MAIN by coord/pair.json', () => {
    expect(readPair(join(root, 'main'))).toEqual({ seat: null, main: join(root, 'main'), worktree: null });
  });
  it('returns null outside any pair setup', () => {
    expect(readPair(tmpdir())).toBeNull();
  });
});

describe('run', () => {
  it('captures output and exit codes without throwing', async () => {
    const ok = await run(process.execPath, ['-e', 'process.stdout.write("hi"); process.exit(3)'], { cwd: tmpdir() });
    expect(ok).toMatchObject({ code: 3, stdout: 'hi' });
    const missing = await run('definitely-not-a-command-xyz', [], { cwd: tmpdir() });
    expect(missing.code).toBe(-1);
  });
});
