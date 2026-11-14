import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pairJsonPath, readStatus, stopPath, worktreePath } from './coord.js';
import { git, type RunResult } from './lib.js';
import { ensureGitignore, renderPreamble, setup } from './setup.js';
import { sync, type SyncOptions } from './sync.js';

const OK: RunResult = { code: 0, stdout: '', stderr: '' };
const quiet = () => {};

interface Env {
  root: string;
  main: string;
  a: string;
  b: string;
}

async function makeEnv(): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), 'click-pairenv-'));
  const main = join(root, 'main');
  mkdirSync(main);
  await git(['init', '-q', '-b', 'main'], main);
  await git(['config', 'user.email', 't@example.com'], main);
  await git(['config', 'user.name', 'Test'], main);
  await git(['config', 'core.autocrlf', 'false'], main);
  writeFileSync(join(main, 'README.md'), 'x\n');
  writeFileSync(join(main, 'package.json'), '{"name":"x"}\n');
  writeFileSync(join(main, '.gitignore'), '.click/\nbench/repo/\n'); // as in the real repo
  await git(['add', '-A'], main);
  await git(['commit', '-q', '-m', 'init'], main);
  mkdirSync(join(main, 'bench', 'repo'), { recursive: true }); // gitignored in the real repo; untracked here
  writeFileSync(join(main, 'bench', 'repo', 'marker.txt'), 'shared clone');
  await setup({ main, agents: { a: 'codex', b: 'claude' }, log: quiet });
  return { root, main, a: worktreePath(main, 'a'), b: worktreePath(main, 'b') };
}

async function commitIn(dir: string, rel: string, content: string, msg: string): Promise<void> {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  await git(['add', rel], dir);
  await git(['commit', '-q', '-m', msg], dir);
}

const sha = async (dir: string, ref = 'HEAD') => (await git(['rev-parse', ref], dir)).trim();
const opts = (cwd: string, extra: Partial<SyncOptions> = {}): SyncOptions => ({
  cwd,
  check: async () => OK,
  install: async () => OK,
  sleep: async () => {},
  log: quiet,
  ...extra,
});

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
}, 60_000);
afterEach(() => {
  rmSync(env.root, { recursive: true, force: true });
});

describe('setup (PROMPTS 015)', () => {
  it('creates both worktrees, markers, preambles and coord files', async () => {
    for (const [seat, wt] of [['a', env.a], ['b', env.b]] as const) {
      expect(existsSync(wt)).toBe(true);
      expect((await git(['symbolic-ref', '--short', 'HEAD'], wt)).trim()).toBe(`lane/${seat}`);
      expect(JSON.parse(readFileSync(join(wt, '.pair.json'), 'utf8'))).toEqual({ seat, main: env.main, worktree: wt });
      const claude = readFileSync(join(wt, 'CLAUDE.md'), 'utf8');
      expect(claude).toContain(`Seat ${seat.toUpperCase()}`);
      expect(claude).toContain(env.main);
      expect(readFileSync(join(wt, 'AGENTS.md'), 'utf8')).toBe(claude);
      expect(readFileSync(join(wt, 'bench', 'repo', 'marker.txt'), 'utf8')).toBe('shared clone'); // linked, not copied
      writeFileSync(join(wt, '.click', 'cache', `from-${seat}.json`), '{}');
    }
    expect(existsSync(join(env.main, '.click', 'cache', 'from-a.json')) && existsSync(join(env.main, '.click', 'cache', 'from-b.json'))).toBe(true);
    const pair = JSON.parse(readFileSync(pairJsonPath(env.main), 'utf8'));
    expect(pair.seats.a).toMatchObject({ branch: 'lane/a', agent: 'codex' });
    expect(readStatus(env.main, 'b').state).toBe('idle');
    expect(existsSync(join(env.main, 'coord', 'requests', 'done'))).toBe(true);
    expect((await git(['log', '-1', '--format=%s'], env.main)).trim()).toBe('pair: ignore coord/ and .pair.json');
    expect((await git(['status', '--porcelain'], env.main)).trim()).toBe(''); // coord/ is ignored
  });

  it('is idempotent', async () => {
    const before = await sha(env.main);
    const r = await setup({ main: env.main, agents: { a: 'codex', b: 'claude' }, log: quiet });
    expect(r).toEqual({ created: [], existing: ['a', 'b'], gitignoreCommitted: false });
    expect(await sha(env.main)).toBe(before);
  });

  it('refuses a dirty MAIN and a failing check', async () => {
    writeFileSync(join(env.main, 'README.md'), 'changed\n');
    await expect(setup({ main: env.main, agents: { a: 'x', b: 'y' }, log: quiet })).rejects.toThrow(/uncommitted/);
    await git(['checkout', '--', 'README.md'], env.main);
    const failing = async () => ({ code: 1, stdout: 'boom', stderr: '' });
    await expect(setup({ main: env.main, agents: { a: 'x', b: 'y' }, check: failing, log: quiet })).rejects.toThrow(/check failed/);
  });

  it('ensureGitignore adds only the missing lines', () => {
    expect(ensureGitignore('node_modules/\n')).toEqual({ text: 'node_modules/\n\n# Pair mode (PLAN §14)\ncoord/\n.pair.json\n', changed: true });
    expect(ensureGitignore('coord/\n.pair.json\n').changed).toBe(false);
    expect(ensureGitignore('a\ncoord/').text.endsWith('.pair.json\n')).toBe(true);
  });

  it('renderPreamble gives each seat its own API rule', () => {
    const p = { main: '/m', worktree: '/w' };
    expect(renderPreamble({ ...p, seat: 'b', agent: 'claude' })).toMatch(/never make paid API calls/);
    expect(renderPreamble({ ...p, seat: 'a', agent: 'codex' })).toMatch(/you own every paid API call/);
  });
});

describe('sync (PROMPTS 016)', () => {
  it('lands both seats when they sync at the same time, with linear history', async () => {
    await commitIn(env.a, 'bench/src/a.ts', 'a\n', 'A/031: runner');
    await commitIn(env.b, 'packages/core/src/graph/ppr.ts', 'b\n', 'B/088: ppr');
    const [ra, rb] = await Promise.all([sync(opts(env.a)), sync(opts(env.b))]);
    expect(ra.ok && rb.ok).toBe(true);
    const subjects = (await git(['log', '--format=%s', 'main'], env.main)).split('\n');
    expect(subjects).toEqual(expect.arrayContaining(['A/031: runner', 'B/088: ppr']));
    expect((await git(['rev-list', '--merges', 'main'], env.main)).trim()).toBe('');
    expect(existsSync(join(env.main, 'bench/src/a.ts')) && existsSync(join(env.main, 'packages/core/src/graph/ppr.ts'))).toBe(true);
    expect(readStatus(env.main, 'a').lastIntegrated).not.toBeNull();
  }, 60_000);

  it('blocks a commit that touches the other lane', async () => {
    await commitIn(env.a, 'packages/core/src/graph/ppr.ts', 'x\n', 'A/031: oops');
    const before = await sha(env.main);
    const r = await sync(opts(env.a));
    expect(r).toMatchObject({ ok: false, step: 'ownership' });
    expect(await sha(env.main)).toBe(before);
  });

  it('respects coord/STOP', async () => {
    await commitIn(env.a, 'bench/src/a.ts', 'a\n', 'A/031');
    writeFileSync(stopPath(env.main), 'main is red: B/090 broke pack tests');
    const r = await sync(opts(env.a));
    expect(r).toMatchObject({ ok: false, step: 'stop' });
    if (!r.ok) expect(r.message).toContain('main is red');
  });

  it('refuses a dirty worktree', async () => {
    await commitIn(env.a, 'bench/src/a.ts', 'a\n', 'A/031');
    writeFileSync(join(env.a, 'bench/src/a.ts'), 'edited but not committed\n');
    expect(await sync(opts(env.a))).toMatchObject({ ok: false, step: 'dirty' });
  });

  it('never touches main when the check fails after rebase', async () => {
    await commitIn(env.a, 'bench/src/a.ts', 'a\n', 'A/031');
    const before = await sha(env.main);
    const r = await sync(opts(env.a, { check: async () => ({ code: 1, stdout: 'FAIL metrics.test.ts', stderr: '' }) }));
    expect(r).toMatchObject({ ok: false, step: 'check' });
    expect(await sha(env.main)).toBe(before);
  });

  it('tags the integrated commit and never moves an existing tag', async () => {
    await commitIn(env.b, 'packages/core/src/indexer/build.ts', 'b\n', 'B/057: build');
    const r = await sync(opts(env.b, { tag: 'sync/build' }));
    expect(r.ok).toBe(true);
    expect(await sha(env.main, 'sync/build')).toBe(await sha(env.main));
    await commitIn(env.b, 'packages/core/src/indexer/more.ts', 'c\n', 'B/058');
    expect(await sync(opts(env.b, { tag: 'sync/build' }))).toMatchObject({ ok: false, step: 'tag' });
  });

  it('aborts a rebase that conflicts in a file it does not own, leaving the worktree as it was', async () => {
    await commitIn(env.b, 'package.json', '{"name":"b"}\n', 'deps: b');
    expect((await sync(opts(env.b))).ok).toBe(true);
    await commitIn(env.a, 'package.json', '{"name":"a"}\n', 'deps: a');
    const head = await sha(env.a);
    const r = await sync(opts(env.a));
    expect(r).toMatchObject({ ok: false, step: 'rebase' });
    if (!r.ok) expect(r.message).toMatch(/don't own/);
    expect(await sha(env.a)).toBe(head);
    expect((await git(['status', '--porcelain', '--untracked-files=no'], env.a)).trim()).toBe('');
  }, 60_000);

  it('is a no-op when there is nothing to integrate', async () => {
    expect(await sync(opts(env.a))).toMatchObject({ ok: true, noop: true });
  });

  it('refuses outside a worktree', async () => {
    expect(await sync(opts(env.main))).toMatchObject({ ok: false, step: 'locate' });
  });
});
