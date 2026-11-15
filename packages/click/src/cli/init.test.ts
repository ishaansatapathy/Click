import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runInit, runUninstall, type InitDeps } from './init.js';

let root: string;
let tools: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'click-init-'));
  tools = mkdtempSync(join(tmpdir(), 'click-init-tools-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(tools, 'dist', 'hooks'), { recursive: true });
  for (const file of ['click.js', 'mcp.js']) writeFileSync(join(tools, 'dist', file), '');
  for (const file of ['prompt.js', 'stop.js']) writeFileSync(join(tools, 'dist', 'hooks', file), '');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(tools, { recursive: true, force: true });
});

const capture = () => {
  let out = ''; let err = '';
  return { io: { out: (text: string) => { out += `${text}\n`; }, err: (text: string) => { err += `${text}\n`; } }, out: () => out, err: () => err };
};
const deps = (calls: string[]): InitDeps => ({
  agents: { claude: true, codex: true },
  paths: {
    cli: join(tools, 'dist', 'click.js'),
    mcp: join(tools, 'dist', 'mcp.js'),
    hooks: { prompt: join(tools, 'dist', 'hooks', 'prompt.js'), stop: join(tools, 'dist', 'hooks', 'stop.js') },
  },
  pull: async () => (calls.push('pull'), 1),
  index: async () => (calls.push('index'), 0),
  startDaemon: async () => { calls.push('daemon'); },
});

describe('click init / uninstall (PROMPT 175)', () => {
  it('installs both detected agents, .click/enabled, git exclusion and hook; second init changes no files', async () => {
    const calls: string[] = [];
    const c = capture();
    expect(await runInit([], c.io, root, deps(calls))).toBe(0);
    expect(calls).toEqual(['pull', 'index', 'daemon']);
    expect(existsSync(join(root, '.click', 'enabled'))).toBe(true);
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain('.click/');
    expect(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers.click).toBeTruthy();
    expect(readFileSync(join(root, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.click]');
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toContain('get_context');
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('get_context');
    expect(readFileSync(join(root, '.git', 'hooks', 'post-commit'), 'utf8')).toContain('reindex --changed');
    const files = ['.mcp.json', 'CLAUDE.md', 'AGENTS.md', '.codex/config.toml', '.claude/settings.json', '.git/info/exclude', '.git/hooks/post-commit', '.click/enabled'];
    const once = new Map(files.map((file) => [file, readFileSync(join(root, file), 'utf8')]));
    expect(await runInit([], capture().io, root, deps(calls))).toBe(0);
    for (const [file, text] of once) expect(readFileSync(join(root, file), 'utf8'), file).toBe(text);
  });

  it('installs host-neutral project MCP for Cursor-style and future clients without Claude files', async () => {
    const d = deps([]);
    d.agents = { claude: false, codex: false, cursor: true };
    expect(await runInit([], capture().io, root, d)).toBe(0);
    expect(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers.click).toBeTruthy();
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(join(root, '.codex', 'config.toml'))).toBe(false);
  });

  it('init then uninstall restores original agent files byte-identically', async () => {
    const originals = {
      'CLAUDE.md': '# Claude\r\nKeep.\r\n',
      'AGENTS.md': '# Agents\nKeep.\n',
      '.mcp.json': '{ "mcpServers": { "mine": { "command": "mine" } } }',
      '.codex/config.toml': 'model = "gpt-6"\n',
      '.claude/settings.json': '{ "permissions": { "allow": ["Read"] } }',
      '.git/info/exclude': '# keep me\n',
    };
    for (const [file, text] of Object.entries(originals)) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    const originalHook = '#!/bin/sh\necho mine\n';
    writeFileSync(join(root, '.git', 'hooks', 'post-commit'), originalHook);
    expect(await runInit([], capture().io, root, deps([]))).toBe(0);
    expect(await runUninstall([], capture().io, root)).toBe(0);
    for (const [file, text] of Object.entries(originals)) expect(readFileSync(join(root, file), 'utf8'), file).toBe(text);
    expect(readFileSync(join(root, '.git', 'hooks', 'post-commit'), 'utf8')).toBe(originalHook);
    expect(existsSync(join(root, '.click', 'enabled'))).toBe(false);
    expect(existsSync(join(root, '.click', 'install-state.json'))).toBe(false);
  });

  it('dry-run, switches, usage and outside-repo error are safe', async () => {
    const c = capture();
    expect(await runInit(['--dry-run', '--no-codex', '--no-githook', '--statusline'], c.io, root, deps([]))).toBe(0);
    expect(c.out()).toContain('no Codex; no git hook');
    expect(existsSync(join(root, '.click'))).toBe(false);
    expect(await runInit(['--wat'], capture().io, root, deps([]))).toBe(2);
    expect(await runUninstall(['x'], capture().io, root)).toBe(2);
    const outside = mkdtempSync(join(tmpdir(), 'click-init-outside-'));
    try {
      const bad = capture();
      expect(await runInit([], bad.io, outside, deps([]))).toBe(1);
      expect(bad.err()).toContain('not inside a git repository');
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});
