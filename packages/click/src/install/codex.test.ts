import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AGENTS_START, CODEX_START, CodexInstallError, installCodex, uninstallCodex } from './codex.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'click-codex-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const config = () => join(root, '.codex', 'config.toml');
const agents = () => join(root, 'AGENTS.md');
const promptHook = () => join(root, 'click', 'dist', 'hooks', 'prompt.js');
const options = (mcpPath: string) => ({ root, mcpPath, promptHookPath: promptHook() });

describe('installCodex (PROMPT 173)', () => {
  it('adds the official project-scoped MCP table and the AGENTS marker without changing existing content', async () => {
    writeFileSync(join(root, 'AGENTS.md'), '# Existing rules\n\n- Keep this.\n');
    const mcpPath = join(root, 'node modules', 'click', 'dist', 'mcp.js');
    const result = await installCodex(options(mcpPath));

    expect(result).toMatchObject({ changed: true, created: [config()], updated: [agents()] });
    expect(readFileSync(config(), 'utf8')).toBe([
      CODEX_START,
      '[mcp_servers.click]',
      'command = "node"',
      `args = [${JSON.stringify(mcpPath)}]`,
      '',
      '[[hooks.UserPromptSubmit]]',
      '',
      '[[hooks.UserPromptSubmit.hooks]]',
      'type = "command"',
      `command = ${JSON.stringify(`node "${promptHook().replace(/\\/g, '/')}"`)}`,
      'timeout = 3',
      '# <<< click <<<',
      '',
    ].join('\n'));
    expect(readFileSync(agents(), 'utf8')).toBe([
      '# Existing rules', '', '- Keep this.', '', AGENTS_START, '## Click context', '',
      'For any task that changes code, call the `get_context` tool first unless a `<click_context>` block is already present.',
      '<!-- click:end -->', '',
    ].join('\n'));
  });

  it('is idempotent, and a moved MCP bundle updates only our managed block', async () => {
    const first = join(root, 'first', 'mcp.js');
    await installCodex(options(first));
    const once = { config: readFileSync(config(), 'utf8'), agents: readFileSync(agents(), 'utf8') };
    expect((await installCodex(options(first))).changed).toBe(false);
    expect(readFileSync(config(), 'utf8')).toBe(once.config);
    expect(readFileSync(agents(), 'utf8')).toBe(once.agents);

    const second = join(root, 'second', 'mcp.js');
    const moved = await installCodex(options(second));
    expect(moved).toMatchObject({ changed: true, created: [], updated: [config()] });
    expect(readFileSync(config(), 'utf8')).toContain(JSON.stringify(second));
    expect(readFileSync(config(), 'utf8')).not.toContain(JSON.stringify(first));
    expect(readFileSync(agents(), 'utf8')).toBe(once.agents);
  });

  it('uninstall restores pre-existing files byte-for-byte and never removes unrelated settings', async () => {
    const originalConfig = 'model = "gpt-6"\n[mcp_servers.mine]\ncommand = "mine"\n';
    const originalAgents = '# Team\r\n\r\nKeep CRLF and no other changes.\r\n';
    mkdirSync(join(root, '.codex'));
    writeFileSync(config(), originalConfig);
    writeFileSync(agents(), originalAgents);
    await installCodex(options(join(root, 'mcp.js')));
    expect((await uninstallCodex({ root })).changed).toBe(true);
    expect(readFileSync(config(), 'utf8')).toBe(originalConfig);
    expect(readFileSync(agents(), 'utf8')).toBe(originalAgents);
    expect((await uninstallCodex({ root })).changed).toBe(false);
  });

  it('removes files that contained only our blocks', async () => {
    await installCodex(options(join(root, 'mcp.js')));
    await uninstallCodex({ root });
    expect(existsSync(config())).toBe(false);
    expect(existsSync(agents())).toBe(false);
  });

  it('refuses to shadow a user-owned click MCP table', async () => {
    mkdirSync(join(root, '.codex'));
    writeFileSync(config(), '[mcp_servers.click]\ncommand = "custom"\n');
    await expect(installCodex(options(join(root, 'mcp.js')))).rejects.toBeInstanceOf(CodexInstallError);
    expect(readFileSync(config(), 'utf8')).toBe('[mcp_servers.click]\ncommand = "custom"\n');
    expect(existsSync(agents())).toBe(false);
  });

  it('refuses incomplete or duplicate markers instead of corrupting the file', async () => {
    writeFileSync(agents(), `${AGENTS_START}\nunfinished\n`);
    await expect(installCodex(options(join(root, 'mcp.js')))).rejects.toThrow(/incomplete Click marker/);
    expect(readFileSync(agents(), 'utf8')).toBe(`${AGENTS_START}\nunfinished\n`);
    expect(existsSync(config())).toBe(false);
  });
});
