import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHookError, hookScript, installGitHook, shq, START, uninstallGitHook } from './githook.js';

let repo: string;
let tools: string;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'click-git-'));
  tools = mkdtempSync(join(tmpdir(), 'click-gittools-'));
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), '1');
  git('add', '.');
});
/** A background reindex may still be running with the repo as its working directory; Windows refuses to delete it for a moment. */
async function removeDir(dir: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i >= 40) throw e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}
afterEach(async () => {
  await removeDir(repo);
  await removeDir(tools);
});

/** A stand-in for click.js that records how it was called (and optionally takes its time). */
function fakeCli(dir: string = tools, name = 'click.js', sleepMs = 0): { path: string; marker: string; calls: () => string[] } {
  const marker = join(dir, `${name}.calls`);
  const path = join(dir, name);
  writeFileSync(path, `const fs=require('node:fs');setTimeout(()=>fs.appendFileSync(${JSON.stringify(marker)},process.argv.slice(2).join(' ')+'\\n'),${sleepMs});`);
  return { path, marker, calls: () => (existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : []) };
}
const until = async (check: () => boolean, ms = 8_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  expect(check()).toBe(true);
};
const hooks = () => join(repo, '.git', 'hooks');

describe('installGitHook (PROMPTS 118)', () => {
  it('installs a post-commit sh script that runs `reindex --changed` after a real commit, without slowing it', async () => {
    const cli = fakeCli(tools, 'click.js', 2_500); // takes 2.5 s: must not hold the commit
    const r = await installGitHook({ root: repo, cliPath: cli.path });
    expect(r).toMatchObject({ changed: true, chained: [], hooks: [join(hooks(), 'post-commit')] });
    const script = readFileSync(join(hooks(), 'post-commit'), 'utf8');
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain(START);
    expect(script).toContain('reindex --changed');
    expect(script).not.toContain('\r');
    if (process.platform !== 'win32') expect(statSync(join(hooks(), 'post-commit')).mode & 0o111).not.toBe(0);

    const t0 = Date.now();
    git('commit', '-q', '-m', 'first');
    expect(Date.now() - t0).toBeLessThan(2_000); // the 2.5 s reindex runs in the background
    await until(() => cli.calls().length > 0);
    expect(cli.calls()).toEqual(['reindex --changed']);
  }, 30_000);

  it('chains after an existing hook: it is kept, called first with git\'s arguments, and both run', async () => {
    const mine = join(tools, 'mine.txt');
    writeFileSync(join(hooks(), 'post-commit'), `#!/bin/sh\necho "mine $#" >> ${shq(mine.replace(/\\/g, '/'))}\nexit 7\n`);
    chmodSync(join(hooks(), 'post-commit'), 0o755);
    const cli = fakeCli();
    const r = await installGitHook({ root: repo, cliPath: cli.path });
    expect(r.chained).toEqual([join(hooks(), 'post-commit.pre-click')]);
    expect(readFileSync(join(hooks(), 'post-commit.pre-click'), 'utf8')).toContain('echo "mine $#"'); // untouched
    git('commit', '-q', '-m', 'second');
    await until(() => cli.calls().length > 0 && existsSync(mine));
    expect(readFileSync(mine, 'utf8')).toBe('mine 0\n'); // post-commit gets no arguments
    expect(cli.calls()).toEqual(['reindex --changed']); // and its failing exit code did not stop ours
  }, 30_000);

  it('is idempotent: installing again changes nothing and never overwrites the saved original', async () => {
    writeFileSync(join(hooks(), 'post-commit'), '#!/bin/sh\necho original\n');
    const cli = fakeCli();
    await installGitHook({ root: repo, cliPath: cli.path });
    const once = readFileSync(join(hooks(), 'post-commit'), 'utf8');
    const second = await installGitHook({ root: repo, cliPath: cli.path });
    expect(second.changed).toBe(false);
    expect(second.chained).toEqual([join(hooks(), 'post-commit.pre-click')]);
    expect(readFileSync(join(hooks(), 'post-commit'), 'utf8')).toBe(once);
    expect(readFileSync(join(hooks(), 'post-commit.pre-click'), 'utf8')).toContain('echo original');
  });

  it('a moved install updates the path in place', async () => {
    const a = fakeCli(tools, 'click.js');
    await installGitHook({ root: repo, cliPath: a.path });
    const other = mkdtempSync(join(tmpdir(), 'click-gittools2-'));
    try {
      const b = fakeCli(other, 'click.js');
      const r = await installGitHook({ root: repo, cliPath: b.path });
      expect(r.changed).toBe(true);
      expect(readFileSync(join(hooks(), 'post-commit'), 'utf8')).toContain(b.path.replace(/\\/g, '/'));
      expect(existsSync(join(hooks(), 'post-commit.pre-click'))).toBe(false);
      git('commit', '-q', '-m', 'x');
      await until(() => b.calls().length > 0);
      expect(a.calls()).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  }, 30_000);

  it('survives paths with spaces and quotes', async () => {
    const odd = join(tools, process.platform === 'win32' ? "it's a dir with $pecial chars" : `it's a "dir" with $pecial chars`); // Windows forbids " in names
    mkdirSync(odd);
    const cli = fakeCli(odd, 'click.js');
    await installGitHook({ root: repo, cliPath: cli.path });
    git('commit', '-q', '-m', 'odd');
    await until(() => cli.calls().length > 0);
    expect(cli.calls()).toEqual(['reindex --changed']);
  }, 30_000);

  it('a broken click path or a missing node never fails the commit', async () => {
    await installGitHook({ root: repo, cliPath: join(tools, 'does-not-exist.js'), nodePath: join(tools, 'no-node') });
    expect(() => git('commit', '-q', '-m', 'still fine')).not.toThrow();
    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1);
  }, 30_000);

  it('respects core.hooksPath', async () => {
    const custom = join(repo, '.githooks');
    git('config', 'core.hooksPath', '.githooks');
    const cli = fakeCli();
    const r = await installGitHook({ root: repo, cliPath: cli.path });
    expect(r.hooksDir).toBe(custom);
    expect(existsSync(join(custom, 'post-commit'))).toBe(true);
    expect(existsSync(join(hooks(), 'post-commit'))).toBe(false);
    git('commit', '-q', '-m', 'via custom hooks path');
    await until(() => cli.calls().length > 0);
  }, 30_000);

  it('works from a subdirectory of the repo and for other events when asked', async () => {
    const sub = join(repo, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    const r = await installGitHook({ root: sub, cliPath: fakeCli().path, events: ['post-commit', 'post-merge', 'post-checkout'] });
    expect(r.hooks.map((h) => h.replace(/\\/g, '/').split('/').pop())).toEqual(['post-commit', 'post-merge', 'post-checkout']);
    expect(readFileSync(join(hooks(), 'post-merge'), 'utf8')).toContain('post-merge.pre-click');
  });

  it('outside a git repository: a clear error, nothing written', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'click-nogit-'));
    try {
      await expect(installGitHook({ root: bare, cliPath: '/x/click.js' })).rejects.toBeInstanceOf(GitHookError);
      expect(existsSync(join(bare, '.git'))).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('refuses to clobber when someone else\'s hook AND a saved original both exist', async () => {
    writeFileSync(join(hooks(), 'post-commit.pre-click'), '#!/bin/sh\necho saved\n');
    writeFileSync(join(hooks(), 'post-commit'), '#!/bin/sh\necho new\n');
    await expect(installGitHook({ root: repo, cliPath: '/x/click.js' })).rejects.toThrow(/merge them by hand/);
    expect(readFileSync(join(hooks(), 'post-commit'), 'utf8')).toContain('echo new');
  });
});

describe('uninstallGitHook (PROMPTS 118)', () => {
  it('removes ours and puts the original back', async () => {
    writeFileSync(join(hooks(), 'post-commit'), '#!/bin/sh\necho original\n');
    await installGitHook({ root: repo, cliPath: fakeCli().path });
    const r = await uninstallGitHook({ root: repo });
    expect(r.restored).toEqual([join(hooks(), 'post-commit')]);
    expect(readFileSync(join(hooks(), 'post-commit'), 'utf8')).toBe('#!/bin/sh\necho original\n');
    expect(existsSync(join(hooks(), 'post-commit.pre-click'))).toBe(false);
    expect(await uninstallGitHook({ root: repo })).toEqual({ removed: [], restored: [] }); // idempotent
  });

  it('with no earlier hook it just removes ours; a hook that is not ours is never touched', async () => {
    await installGitHook({ root: repo, cliPath: fakeCli().path });
    expect((await uninstallGitHook({ root: repo })).removed).toHaveLength(1);
    expect(existsSync(join(hooks(), 'post-commit'))).toBe(false);
    writeFileSync(join(hooks(), 'post-commit'), '#!/bin/sh\necho someone else\n');
    expect(await uninstallGitHook({ root: repo })).toEqual({ removed: [], restored: [] });
    expect(readFileSync(join(hooks(), 'post-commit'), 'utf8')).toContain('someone else');
  });
});

describe('hookScript', () => {
  it('quotes everything it was given, and always exits 0', () => {
    const s = hookScript('post-commit', { cliPath: "C:\\Users\\O'Neil\\click\\dist\\click.js", nodePath: 'C:\\Program Files\\nodejs\\node.exe' });
    expect(s).toContain(`'C:/Users/O'\\''Neil/click/dist/click.js'`);
    expect(s).toContain(`'C:/Program Files/nodejs/node.exe'`);
    expect(s.trimEnd().endsWith('exit 0')).toBe(true);
    expect(shq(`a b'c$d`)).toBe(`'a b'\\''c$d'`);
  });
});
