import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHooks } from './hooksCmd.js';

let repo: string;
let dist: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'click-hooks-cmd-'));
  dist = mkdtempSync(join(tmpdir(), 'click-hooks-dist-'));
  mkdirSync(join(dist, 'click', 'dist', 'hooks'), { recursive: true });
  writeFileSync(join(dist, 'click', 'dist', 'hooks', 'prompt.js'), '');
  writeFileSync(join(dist, 'click', 'dist', 'click.js'), '');
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(dist, { recursive: true, force: true });
});
const deps = () => ({ paths: { prompt: join(dist, 'click', 'dist', 'hooks', 'prompt.js'), stop: join(dist, 'click', 'dist', 'hooks', 'stop.js') }, cliPath: join(dist, 'click', 'dist', 'click.js') });
function run(argv: string[]) {
  let out = '';
  let err = '';
  return runHooks(argv, { out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`) }, repo, deps()).then((code) => ({ code, out, err }));
}

describe('click hooks (G2 support)', () => {
  it('install --local writes settings.local.json, status shows it, uninstall removes it', async () => {
    const a = await run(['install', '--local']);
    expect(a.code).toBe(0);
    expect(a.out).toContain('settings.local.json');
    expect(existsSync(join(repo, '.claude', 'settings.local.json'))).toBe(true);
    expect(existsSync(join(repo, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(join(repo, '.click'))).toBe(true);
    const s = await run(['status']);
    expect(s.out).toContain('UserPromptSubmit');
    expect(s.out).toContain('.click directory: present');
    expect((await run(['install', '--local'])).out).toContain('already installed');
    expect((await run(['uninstall', '--local'])).out).toContain('removed UserPromptSubmit');
    expect((await run(['status'])).out).toContain('no Click hooks installed');
  });

  it('install --git also installs the post-commit hook, and uninstall --git takes it out', async () => {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const a = await run(['install', '--git']);
    expect(a.out).toContain('git post-commit hook installed');
    expect(readFileSync(join(repo, '.git', 'hooks', 'post-commit'), 'utf8')).toContain('reindex --changed');
    const u = await run(['uninstall', '--git']);
    expect(u.out).toContain('git post-commit hook removed');
    expect(existsSync(join(repo, '.git', 'hooks', 'post-commit'))).toBe(false);
  });

  it('says so when the hook is not built, and when the settings file is broken', async () => {
    rmSync(join(dist, 'click', 'dist', 'hooks', 'prompt.js'));
    const a = await run(['install']);
    expect(a.code).toBe(1);
    expect(a.err).toContain('pnpm build');
    writeFileSync(join(dist, 'click', 'dist', 'hooks', 'prompt.js'), '');
    mkdirSync(join(repo, '.claude'));
    writeFileSync(join(repo, '.claude', 'settings.json'), '{ nope');
    const b = await run(['install']);
    expect(b.code).toBe(1);
    expect(b.err).toContain('not valid JSON');
    expect(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8')).toBe('{ nope');
  });

  it('status flags a hook whose file has disappeared; bad usage exits 2', async () => {
    await run(['install', '--local']);
    rmSync(join(dist, 'click', 'dist', 'hooks', 'prompt.js'));
    expect((await run(['status'])).out).toContain('does not exist');
    expect((await run([])).code).toBe(2);
    expect((await run(['frobnicate'])).code).toBe(2);
    expect((await run(['install', '--wat'])).code).toBe(2);
  });
});
