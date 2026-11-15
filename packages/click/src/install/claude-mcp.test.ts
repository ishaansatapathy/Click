import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClaudeMcpInstallError, installClaudeMcp, uninstallClaudeMcp } from './claude-mcp.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'click-claude-mcp-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const mcp = () => join(root, '.mcp.json');
const backup = () => `${mcp()}.click-bak`;
const claude = () => join(root, 'CLAUDE.md');
const server = () => join(root, 'dist', 'mcp.js');

describe('installClaudeMcp (PROMPT 174)', () => {
  it('creates the documented project stdio entry and CLAUDE.md fallback', async () => {
    const result = await installClaudeMcp({ root, mcpPath: server() });
    expect(result).toMatchObject({ changed: true, backedUp: false, mcpPath: mcp(), claudePath: claude() });
    expect(JSON.parse(readFileSync(mcp(), 'utf8'))).toEqual({ mcpServers: { click: { command: 'node', args: [server()] } } });
    expect(readFileSync(claude(), 'utf8')).toContain('call the `get_context` tool first');
  });

  it('preserves other servers and root keys, backs up once, and is idempotent', async () => {
    const original = '{"version":1,"mcpServers":{"mine":{"command":"mine"}}}\n';
    writeFileSync(mcp(), original);
    writeFileSync(claude(), '# Existing\n');
    expect((await installClaudeMcp({ root, mcpPath: server() })).backedUp).toBe(true);
    expect(readFileSync(backup(), 'utf8')).toBe(original);
    const parsed = JSON.parse(readFileSync(mcp(), 'utf8'));
    expect(parsed).toMatchObject({ version: 1, mcpServers: { mine: { command: 'mine' }, click: { command: 'node' } } });
    const once = { mcp: readFileSync(mcp(), 'utf8'), claude: readFileSync(claude(), 'utf8'), backup: readFileSync(backup(), 'utf8') };
    expect((await installClaudeMcp({ root, mcpPath: server() })).changed).toBe(false);
    expect(readFileSync(mcp(), 'utf8')).toBe(once.mcp);
    expect(readFileSync(claude(), 'utf8')).toBe(once.claude);
    expect(readFileSync(backup(), 'utf8')).toBe(once.backup);
  });

  it('uninstall restores pre-existing files byte-for-byte', async () => {
    const originalMcp = '{ "mcpServers": { "mine": { "command": "mine" } }, "x": true }';
    const originalClaude = '# Rules\r\n\r\nKeep this.\r\n';
    writeFileSync(mcp(), originalMcp);
    writeFileSync(claude(), originalClaude);
    await installClaudeMcp({ root, mcpPath: server() });
    await uninstallClaudeMcp({ root });
    expect(readFileSync(mcp(), 'utf8')).toBe(originalMcp);
    expect(readFileSync(claude(), 'utf8')).toBe(originalClaude);
    expect(existsSync(backup())).toBe(false);
  });

  it('preserves user edits made after installation while removing only Click', async () => {
    writeFileSync(mcp(), '{"mcpServers":{"mine":{"command":"mine"}}}\n');
    await installClaudeMcp({ root, mcpPath: server() });
    const changed = JSON.parse(readFileSync(mcp(), 'utf8'));
    changed.mcpServers.later = { command: 'later' };
    changed.newSetting = 2;
    writeFileSync(mcp(), `${JSON.stringify(changed, null, 2)}\n`);
    await uninstallClaudeMcp({ root });
    expect(JSON.parse(readFileSync(mcp(), 'utf8'))).toEqual({
      mcpServers: { mine: { command: 'mine' }, later: { command: 'later' } },
      newSetting: 2,
    });
  });

  it('fresh install then uninstall leaves no files', async () => {
    await installClaudeMcp({ root, mcpPath: server() });
    await uninstallClaudeMcp({ root });
    expect(existsSync(mcp())).toBe(false);
    expect(existsSync(claude())).toBe(false);
  });

  it('refuses invalid JSON, invalid mcpServers and a user-owned click entry', async () => {
    for (const text of ['{', '[]', '{"mcpServers":[]}', '{"mcpServers":{"click":{"command":"custom"}}}']) {
      writeFileSync(mcp(), text);
      await expect(installClaudeMcp({ root, mcpPath: server() })).rejects.toBeInstanceOf(ClaudeMcpInstallError);
      expect(readFileSync(mcp(), 'utf8')).toBe(text);
      expect(existsSync(claude())).toBe(false);
    }
  });
});
