// PROMPT 174: Claude Code's project MCP entry and its instruction fallback.
// `.mcp.json` is structured JSON, so the first edit keeps an exact backup. Uninstall restores that backup only when the
// non-Click configuration is semantically unchanged; if the user edited it meanwhile, only mcpServers.click is removed.

import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { writeFileAtomic } from '../../../core/src/util/atomic.js';
import { AGENT_INSTRUCTIONS, AGENTS_END as CLAUDE_END, AGENTS_START as CLAUDE_START } from './codex.js';

const BACKUP_SUFFIX = '.click-bak';

type JsonObject = Record<string, unknown>;

export class ClaudeMcpInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeMcpInstallError';
  }
}

export interface ClaudeMcpInstallOptions {
  root: string;
  /** Absolute path of the bundled stdio MCP entry point (`dist/mcp.js`). */
  mcpPath: string;
  /** Also write Claude's instruction fallback. Generic MCP clients only need `.mcp.json`. Default true. */
  claudeInstructions?: boolean;
}

export interface ClaudeMcpInstallResult {
  changed: boolean;
  mcpPath: string;
  claudePath: string;
  backedUp: boolean;
}

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const readIf = (path: string): Promise<string | null> => readFile(path, 'utf8').then((text) => text, () => null);

function parseConfig(text: string, path: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ClaudeMcpInstallError(`${path} is not valid JSON; repair it by hand first`);
  }
  if (!isObject(value)) throw new ClaudeMcpInstallError(`${path} must contain a JSON object`);
  if (value.mcpServers !== undefined && !isObject(value.mcpServers)) {
    throw new ClaudeMcpInstallError(`${path}.mcpServers must be a JSON object`);
  }
  return value;
}

function clickEntry(mcpPath: string): JsonObject {
  return { command: 'node', args: [resolve(mcpPath)] };
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => sameJson(value, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, i) => key === bk[i] && sameJson(a[key], b[key]));
}

function withoutClick(config: JsonObject): JsonObject {
  const copy = structuredClone(config);
  if (!isObject(copy.mcpServers)) return copy;
  delete copy.mcpServers.click;
  if (!Object.keys(copy.mcpServers).length) delete copy.mcpServers;
  return copy;
}

function locateClaudeBlock(text: string): { start: number; end: number } | null {
  const start = text.indexOf(CLAUDE_START);
  const endMarker = text.indexOf(CLAUDE_END);
  if ((start < 0) !== (endMarker < 0)) throw new ClaudeMcpInstallError('CLAUDE.md has an incomplete Click marker block; repair it by hand first');
  if (start < 0) return null;
  if (text.indexOf(CLAUDE_START, start + CLAUDE_START.length) >= 0 || text.indexOf(CLAUDE_END, endMarker + CLAUDE_END.length) >= 0) {
    throw new ClaudeMcpInstallError('CLAUDE.md has more than one Click marker block; repair it by hand first');
  }
  if (endMarker < start) throw new ClaudeMcpInstallError('CLAUDE.md has Click markers in the wrong order; repair it by hand first');
  return { start, end: endMarker + CLAUDE_END.length };
}

const claudeBlock = (): string => [CLAUDE_START, '## Click context', '', ...AGENT_INSTRUCTIONS.map((line) => `- ${line}`), CLAUDE_END].join('\n');

function installClaudeBlock(text: string): string {
  const found = locateClaudeBlock(text);
  if (found) return text.slice(0, found.start) + claudeBlock() + text.slice(found.end);
  return text + (text.length ? '\n' : '') + claudeBlock() + '\n';
}

function removeClaudeBlock(text: string): string {
  const found = locateClaudeBlock(text);
  if (!found) return text;
  const start = found.start > 0 && text[found.start - 1] === '\n' ? found.start - 1 : found.start;
  const end = text[found.end] === '\n' ? found.end + 1 : found.end;
  return text.slice(0, start) + text.slice(end);
}

async function writeOrRemove(path: string, text: string): Promise<void> {
  if (text.length) await writeFileAtomic(path, text);
  else await rm(path, { force: true });
}

export async function installClaudeMcp(o: ClaudeMcpInstallOptions): Promise<ClaudeMcpInstallResult> {
  const root = resolve(o.root);
  const mcpPath = join(root, '.mcp.json');
  const backupPath = mcpPath + BACKUP_SUFFIX;
  const claudePath = join(root, 'CLAUDE.md');
  const mcpBefore = await readIf(mcpPath);
  const backupBefore = await readIf(backupPath);
  const claudeBefore = await readIf(claudePath);
  const config = mcpBefore === null ? {} : parseConfig(mcpBefore, mcpPath);
  const servers = isObject(config.mcpServers) ? config.mcpServers : {};
  const wanted = clickEntry(o.mcpPath);
  const existing = servers.click;
  if (existing !== undefined && !sameJson(existing, wanted) && backupBefore === null) {
    throw new ClaudeMcpInstallError(`${mcpPath} already defines mcpServers.click outside Click's installation`);
  }
  // Validate CLAUDE.md before making either change.
  const claudeAfter = o.claudeInstructions === false ? (claudeBefore ?? '') : installClaudeBlock(claudeBefore ?? '');
  const mcpAfterObject = { ...config, mcpServers: { ...servers, click: wanted } };
  const mcpAfter = `${JSON.stringify(mcpAfterObject, null, 2)}\n`;
  const mcpChanged = mcpAfter !== (mcpBefore ?? '');
  const claudeChanged = claudeAfter !== (claudeBefore ?? '');
  let backedUp = false;
  if (mcpChanged && mcpBefore !== null && backupBefore === null) {
    await writeFileAtomic(backupPath, mcpBefore);
    backedUp = true;
  }
  if (mcpChanged) await writeFileAtomic(mcpPath, mcpAfter);
  if (claudeChanged) await writeFileAtomic(claudePath, claudeAfter);
  return { changed: mcpChanged || claudeChanged, mcpPath, claudePath, backedUp };
}

export async function uninstallClaudeMcp(o: Pick<ClaudeMcpInstallOptions, 'root'>): Promise<ClaudeMcpInstallResult> {
  const root = resolve(o.root);
  const mcpPath = join(root, '.mcp.json');
  const backupPath = mcpPath + BACKUP_SUFFIX;
  const claudePath = join(root, 'CLAUDE.md');
  const mcpBefore = await readIf(mcpPath);
  const backupBefore = await readIf(backupPath);
  const claudeBefore = await readIf(claudePath);
  const current = mcpBefore === null ? null : parseConfig(mcpBefore, mcpPath);
  const original = backupBefore === null ? null : parseConfig(backupBefore, backupPath);
  const without = current === null ? null : withoutClick(current);
  const mcpAfter = original && without && sameJson(without, original)
    ? backupBefore!
    : without && Object.keys(without).length
      ? `${JSON.stringify(without, null, 2)}\n`
      : '';
  const claudeAfter = removeClaudeBlock(claudeBefore ?? '');
  const mcpChanged = mcpBefore !== null && mcpAfter !== mcpBefore;
  const claudeChanged = claudeBefore !== null && claudeAfter !== claudeBefore;
  if (mcpChanged) await writeOrRemove(mcpPath, mcpAfter);
  if (claudeChanged) await writeOrRemove(claudePath, claudeAfter);
  if (backupBefore !== null) await rm(backupPath, { force: true });
  return { changed: mcpChanged || claudeChanged || backupBefore !== null, mcpPath, claudePath, backedUp: false };
}
