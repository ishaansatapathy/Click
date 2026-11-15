import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultHookPaths, installClaudeHooks, InstallError, isClickCommand, mergeHooks, removeHooks, uninstallClaudeHooks, type HookPaths } from './claude.js';

let root: string;
let dist: string;
let paths: HookPaths;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'click-install-'));
  dist = join(root, 'tools', 'click', 'dist', 'hooks');
  mkdirSync(dist, { recursive: true });
  paths = { prompt: join(dist, 'prompt.js'), stop: join(dist, 'stop.js') };
  writeFileSync(paths.prompt, '');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const settingsPath = (file = 'settings.json') => join(root, '.claude', file);
interface Settings {
  hooks?: Record<string, { hooks: { command: string; timeout?: number }[] }[]>;
  model?: string;
  permissions?: unknown;
  [k: string]: unknown;
}
const readSettings = (file?: string) => JSON.parse(readFileSync(settingsPath(file), 'utf8').replace(/^﻿/, '')) as Settings;
const fwd = (p: string) => p.replace(/\\/g, '/');
const OURS = (file: string) => ({ type: 'command', command: `node "${fwd(file)}"`, timeout: 3 });

describe('installClaudeHooks (PROMPTS 117)', () => {
  it('into no settings at all: creates .claude/settings.json with the UserPromptSubmit entry in the documented shape', async () => {
    const r = await installClaudeHooks({ root, paths });
    expect(r).toMatchObject({ changed: true, created: true, backedUp: false, added: ['UserPromptSubmit'], updated: [] });
    expect(readSettings()).toEqual({ hooks: { UserPromptSubmit: [{ hooks: [OURS(paths.prompt)] }] } });
    expect(readFileSync(settingsPath(), 'utf8').endsWith('\n')).toBe(true);
    expect(existsSync(settingsPath() + '.click-bak')).toBe(false); // nothing to back up yet
    expect(existsSync(join(root, '.click'))).toBe(true);
  });

  it('adds the Stop hook too once its file exists (or when asked)', async () => {
    writeFileSync(paths.stop, '');
    const r = await installClaudeHooks({ root, paths });
    expect(r.added).toEqual(['UserPromptSubmit', 'Stop']);
    expect(readSettings().hooks!.Stop).toEqual([{ hooks: [OURS(paths.stop)] }]);
    rmSync(settingsPath());
    rmSync(paths.stop);
    expect((await installClaudeHooks({ root, paths })).added).toEqual(['UserPromptSubmit']); // no stop.js yet: no dangling hook
    expect((await installClaudeHooks({ root, paths, stop: true })).added).toEqual(['Stop']);
  });

  it('preserves everything the user has: other keys and their order, other hooks, other events, matcher groups', async () => {
    const mine = {
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      permissions: { allow: ['Bash(pnpm test:*)'], deny: [] },
      env: { FOO: 'bar' },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/check.sh' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo hi', timeout: 5 }] }],
      },
      model: 'opus',
    };
    mkdirSync(join(root, '.claude'));
    writeFileSync(settingsPath(), JSON.stringify(mine, null, 2));
    const r = await installClaudeHooks({ root, paths });
    expect(r).toMatchObject({ changed: true, created: false, backedUp: true });
    const after = readSettings();
    expect(Object.keys(after)).toEqual(['$schema', 'permissions', 'env', 'hooks', 'model']);
    expect(after.permissions).toEqual(mine.permissions);
    expect(after.hooks!.PreToolUse).toEqual(mine.hooks.PreToolUse);
    expect(after.hooks!.UserPromptSubmit).toEqual([...mine.hooks.UserPromptSubmit, { hooks: [OURS(paths.prompt)] }]); // theirs first, ours after
    expect(JSON.parse(readFileSync(settingsPath() + '.click-bak', 'utf8'))).toEqual(mine); // the backup is the original
  });

  it('is idempotent: a second run changes nothing, does not rewrite the file and does not touch the backup', async () => {
    mkdirSync(join(root, '.claude'));
    writeFileSync(settingsPath(), JSON.stringify({ model: 'opus' }, null, 2));
    await installClaudeHooks({ root, paths });
    const once = readFileSync(settingsPath(), 'utf8');
    const bak = readFileSync(settingsPath() + '.click-bak', 'utf8');
    const second = await installClaudeHooks({ root, paths });
    expect(second).toMatchObject({ changed: false, backedUp: false, added: [], updated: [] });
    expect(readFileSync(settingsPath(), 'utf8')).toBe(once);
    expect(readFileSync(settingsPath() + '.click-bak', 'utf8')).toBe(bak);
    for (let i = 0; i < 3; i++) await installClaudeHooks({ root, paths });
    expect(readSettings().hooks!.UserPromptSubmit).toHaveLength(1);
  });

  it('an install that moved is updated in place, not duplicated; the backup keeps the very first original', async () => {
    mkdirSync(join(root, '.claude'));
    const original = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }, null, 2);
    writeFileSync(settingsPath(), original);
    await installClaudeHooks({ root, paths });
    const moved: HookPaths = { prompt: join(root, 'elsewhere', 'node_modules', 'click', 'dist', 'hooks', 'prompt.js'), stop: join(root, 'elsewhere', 'node_modules', 'click', 'dist', 'hooks', 'stop.js') };
    const r = await installClaudeHooks({ root, paths: moved });
    expect(r).toMatchObject({ changed: true, added: [], updated: ['UserPromptSubmit'], backedUp: false });
    const entries = readSettings().hooks!.UserPromptSubmit!;
    expect(entries).toHaveLength(2);
    expect(entries[1]!.hooks[0]!.command).toBe(`node "${fwd(moved.prompt)}"`);
    expect(readFileSync(settingsPath() + '.click-bak', 'utf8')).toBe(original);
  });

  it('a stale timeout or type in our entry is repaired', async () => {
    mkdirSync(join(root, '.claude'));
    writeFileSync(settingsPath(), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node "${fwd(paths.prompt)}"`, timeout: 600 }] }] } }));
    expect((await installClaudeHooks({ root, paths })).updated).toEqual(['UserPromptSubmit']);
    expect(readSettings().hooks!.UserPromptSubmit![0]!.hooks[0]!.timeout).toBe(3);
  });

  it('writes forward slashes in the command even for Windows paths, quoted so spaces survive', async () => {
    const spaced = { prompt: 'C:\\Users\\Some One\\tools\\click\\dist\\hooks\\prompt.js', stop: 'C:\\Users\\Some One\\tools\\click\\dist\\hooks\\stop.js' };
    const settings: Settings = {};
    mergeHooks(settings, { prompt: spaced.prompt });
    const command = settings.hooks!.UserPromptSubmit![0]!.hooks[0]!.command;
    expect(command).toMatch(/^node "/);
    expect(command).not.toContain('\\');
    expect(command).toContain('Some One/tools/click/dist/hooks/prompt.js');
  });

  it('keeps the file\'s indentation (4 spaces, tabs) and a BOM', async () => {
    mkdirSync(join(root, '.claude'));
    writeFileSync(settingsPath(), JSON.stringify({ model: 'opus' }, null, 4));
    await installClaudeHooks({ root, paths });
    expect(readFileSync(settingsPath(), 'utf8')).toMatch(/\n {4}"model"/);
    rmSync(settingsPath());
    writeFileSync(settingsPath(), JSON.stringify({ model: 'opus' }, null, '\t'));
    await installClaudeHooks({ root, paths });
    expect(readFileSync(settingsPath(), 'utf8')).toMatch(/\n\t"model"/);
    rmSync(settingsPath());
    writeFileSync(settingsPath(), '\uFEFF' + JSON.stringify({ model: 'opus' }, null, 2));
    await installClaudeHooks({ root, paths });
    expect(readFileSync(settingsPath(), 'utf8').charCodeAt(0)).toBe(0xfeff);
    expect(readSettings().model).toBe('opus');
  });

  it('refuses a settings file it cannot understand, and leaves it exactly as it was', async () => {
    mkdirSync(join(root, '.claude'));
    for (const bad of ['{ "hooks": ', '[]', '"str"', '{"hooks": []}', '{"hooks": {"UserPromptSubmit": {"hooks": []}}}']) {
      writeFileSync(settingsPath(), bad);
      await expect(installClaudeHooks({ root, paths }), bad).rejects.toBeInstanceOf(InstallError);
      expect(readFileSync(settingsPath(), 'utf8')).toBe(bad);
      expect(existsSync(settingsPath() + '.click-bak')).toBe(false);
    }
  });

  it('an empty settings file is treated as {}', async () => {
    mkdirSync(join(root, '.claude'));
    writeFileSync(settingsPath(), '   \n');
    expect((await installClaudeHooks({ root, paths })).changed).toBe(true);
    expect(readSettings().hooks!.UserPromptSubmit).toHaveLength(1);
  });

  it('can target settings.local.json (gitignored, right for machine-specific paths) and leaves settings.json alone', async () => {
    await installClaudeHooks({ root, paths, file: 'settings.local.json' });
    expect(existsSync(settingsPath('settings.local.json'))).toBe(true);
    expect(existsSync(settingsPath())).toBe(false);
  });

  it('keeps .click/ out of git: appended to .git/info/exclude once', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    await installClaudeHooks({ root, paths });
    await installClaudeHooks({ root, paths, file: 'settings.local.json' });
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.match(/^\.click\/$/gm)).toHaveLength(1);
  });

  it('the hook command it writes really runs under a shell and answers (end to end)', async () => {
    const { bundle } = await import('../build/bundle.js');
    const out = join(root, 'real-dist', 'click');
    await bundle({ outdir: join(out, 'dist'), hooksOnly: true });
    const real: HookPaths = { prompt: join(out, 'dist', 'hooks', 'prompt.js'), stop: join(out, 'dist', 'hooks', 'stop.js') };
    await installClaudeHooks({ root, paths: real });
    const command = readSettings().hooks!.UserPromptSubmit![0]!.hooks[0]!.command;
    const stdout = execFileSync(command, { shell: true, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'fix it', cwd: root }), encoding: 'utf8' });
    expect(stdout).toBe(''); // "fix it" is too short: silent, exit 0 (execFileSync throws on a non-zero exit)
  }, 60_000);
});

describe('uninstallClaudeHooks / removeHooks (PROMPTS 117)', () => {
  it('removes only our entries; the user\'s stay, and groups/arrays we created disappear', async () => {
    mkdirSync(join(root, '.claude'));
    const mine = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo hi' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] }, model: 'opus' };
    writeFileSync(settingsPath(), JSON.stringify(mine, null, 2));
    writeFileSync(paths.stop, '');
    await installClaudeHooks({ root, paths });
    const r = await uninstallClaudeHooks({ root });
    expect(r).toMatchObject({ changed: true, removed: ['UserPromptSubmit', 'Stop'] });
    expect(readSettings()).toEqual(mine);
    expect((await uninstallClaudeHooks({ root })).changed).toBe(false); // idempotent
  });

  it('install then uninstall on a fresh repo leaves no hooks key at all', async () => {
    await installClaudeHooks({ root, paths });
    await uninstallClaudeHooks({ root });
    expect(readSettings()).toEqual({});
  });

  it('missing file or unrelated settings: nothing to do', async () => {
    expect((await uninstallClaudeHooks({ root })).changed).toBe(false);
    const s = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } };
    expect(removeHooks(s)).toEqual([]);
    expect(s.hooks.UserPromptSubmit).toHaveLength(1);
  });
});

describe('recognising our entries', () => {
  it('a command is ours when its path has "click" and dist/hooks/(prompt|stop).js, on any OS', () => {
    expect(isClickCommand('node "C:\\Users\\me\\Click\\packages\\click\\dist\\hooks\\prompt.js"')).toBe(true);
    expect(isClickCommand('node "/home/me/node_modules/click/dist/hooks/stop.js"')).toBe(true);
    expect(isClickCommand('node "/home/me/other/dist/hooks/prompt.js"')).toBe(false); // someone else's hook
    expect(isClickCommand('node ./click/scripts/lint.js')).toBe(false);
    expect(isClickCommand(undefined)).toBe(false);
    expect(isClickCommand(42)).toBe(false);
  });

  it('defaultHookPaths finds the built hooks next to a bundle, or in the package dist', () => {
    const here = join(root, 'pkg', 'dist');
    mkdirSync(join(here, 'hooks'), { recursive: true });
    writeFileSync(join(here, 'hooks', 'prompt.js'), '');
    expect(defaultHookPaths(here).prompt).toBe(join(here, 'hooks', 'prompt.js'));
    expect(defaultHookPaths(join(root, 'nothing', 'here')).prompt.replace(/\\/g, '/')).toMatch(/dist\/hooks\/prompt\.js$/);
  });
});
