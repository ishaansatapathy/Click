// PROMPT 173: project-scoped Codex installation.
// Codex loads MCP servers from a trusted repo's `.codex/config.toml` and instructions from the repo-root AGENTS.md.
// Both additions are delimited, so re-install updates in place and uninstall leaves every user-owned byte alone.

import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { writeFileAtomic } from '../../../core/src/util/atomic.js';

export const CODEX_START = '# >>> click (managed block: `click uninstall` removes it) >>>';
export const CODEX_END = '# <<< click <<<';
export const AGENTS_START = '<!-- click:start -->';
export const AGENTS_END = '<!-- click:end -->';

export const AGENT_INSTRUCTIONS = [
  'At the start of a task, call `read_notes` and `list_tasks` so you do not repeat another agent\'s work.',
  'Before taking a listed task, call `claim_task` with your agent name.',
  'Before changing code, call `get_context` with your agent name unless a `<click_context>` block is already present.',
  'When you finish or pause, call `handoff` with what changed, what remains, and the relevant files.',
] as const;

export class CodexInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexInstallError';
  }
}

export interface CodexInstallOptions {
  root: string;
  /** Absolute path of the bundled stdio MCP entry point (`dist/mcp.js`). */
  mcpPath: string;
  /** Absolute path of the bundled UserPromptSubmit entry point (`dist/hooks/prompt.js`). */
  promptHookPath: string;
}

export interface CodexInstallResult {
  changed: boolean;
  configPath: string;
  agentsPath: string;
  created: string[];
  updated: string[];
}

interface ManagedBlock {
  start: string;
  end: string;
  body: string;
  label: string;
}

const readIf = (path: string): Promise<string | null> => readFile(path, 'utf8').then((text) => text, () => null);

function locate(text: string, block: ManagedBlock): { start: number; end: number } | null {
  const start = text.indexOf(block.start);
  const endMarker = text.indexOf(block.end);
  if ((start < 0) !== (endMarker < 0)) throw new CodexInstallError(`${block.label} has an incomplete Click marker block; repair it by hand first`);
  if (start < 0) return null;
  if (text.indexOf(block.start, start + block.start.length) >= 0 || text.indexOf(block.end, endMarker + block.end.length) >= 0) {
    throw new CodexInstallError(`${block.label} has more than one Click marker block; repair it by hand first`);
  }
  if (endMarker < start) throw new CodexInstallError(`${block.label} has Click markers in the wrong order; repair it by hand first`);
  return { start, end: endMarker + block.end.length };
}

function installBlock(text: string, block: ManagedBlock): string {
  const found = locate(text, block);
  if (found) return text.slice(0, found.start) + block.body + text.slice(found.end);
  return text + (text.length ? '\n' : '') + block.body + '\n';
}

function removeBlock(text: string, block: ManagedBlock): string {
  const found = locate(text, block);
  if (!found) return text;
  // installBlock always owns one separator newline before an appended block and one newline after it.
  const start = found.start > 0 && text[found.start - 1] === '\n' ? found.start - 1 : found.start;
  const end = text[found.end] === '\n' ? found.end + 1 : found.end;
  return text.slice(0, start) + text.slice(end);
}

function tomlString(value: string): string {
  // TOML basic strings and JSON strings share the escaping needed for paths, quotes and control characters.
  return JSON.stringify(value);
}

const commandFor = (file: string): string => `node "${resolve(file).replace(/\\/g, '/')}"`;

export function codexConfigBlock(mcpPath: string, promptHookPath: string): ManagedBlock {
  const body = [
    CODEX_START,
    '[mcp_servers.click]',
    'command = "node"',
    `args = [${tomlString(resolve(mcpPath))}]`,
    '',
    '[[hooks.UserPromptSubmit]]',
    '',
    '[[hooks.UserPromptSubmit.hooks]]',
    'type = "command"',
    `command = ${tomlString(commandFor(promptHookPath))}`,
    'timeout = 3',
    CODEX_END,
  ].join('\n');
  return { start: CODEX_START, end: CODEX_END, body, label: '.codex/config.toml' };
}

export function codexAgentsBlock(): ManagedBlock {
  const body = [AGENTS_START, '## Click context', '', ...AGENT_INSTRUCTIONS.map((line) => `- ${line}`), AGENTS_END].join('\n');
  return { start: AGENTS_START, end: AGENTS_END, body, label: 'AGENTS.md' };
}

async function writeChanged(path: string, before: string | null, after: string): Promise<boolean> {
  if (after === (before ?? '')) return false;
  if (!after.length) await rm(path, { force: true });
  else await writeFileAtomic(path, after);
  return true;
}

export async function installCodex(o: CodexInstallOptions): Promise<CodexInstallResult> {
  const root = resolve(o.root);
  const configPath = join(root, '.codex', 'config.toml');
  const agentsPath = join(root, 'AGENTS.md');
  const configBefore = await readIf(configPath);
  const agentsBefore = await readIf(agentsPath);
  const configBlock = codexConfigBlock(o.mcpPath, o.promptHookPath);

  // A duplicate TOML table makes the whole config invalid. Never take over an entry we did not create.
  if (!locate(configBefore ?? '', configBlock) && /^\s*\[mcp_servers\.click\]\s*(?:#.*)?$/m.test(configBefore ?? '')) {
    throw new CodexInstallError(`${configPath} already defines [mcp_servers.click] outside Click's managed block`);
  }

  const configAfter = installBlock(configBefore ?? '', configBlock);
  const agentsAfter = installBlock(agentsBefore ?? '', codexAgentsBlock());
  const configChanged = await writeChanged(configPath, configBefore, configAfter);
  const agentsChanged = await writeChanged(agentsPath, agentsBefore, agentsAfter);
  const created = [configBefore === null ? configPath : null, agentsBefore === null ? agentsPath : null].filter((path): path is string => path !== null);
  const updated = [configBefore !== null && configChanged ? configPath : null, agentsBefore !== null && agentsChanged ? agentsPath : null].filter((path): path is string => path !== null);
  return { changed: configChanged || agentsChanged, configPath, agentsPath, created, updated };
}

export async function uninstallCodex(o: Pick<CodexInstallOptions, 'root'>): Promise<CodexInstallResult> {
  const root = resolve(o.root);
  const configPath = join(root, '.codex', 'config.toml');
  const agentsPath = join(root, 'AGENTS.md');
  const configBefore = await readIf(configPath);
  const agentsBefore = await readIf(agentsPath);
  const configAfter = removeBlock(configBefore ?? '', codexConfigBlock(join(root, 'unused-mcp-path'), join(root, 'unused-hook-path')));
  const agentsAfter = removeBlock(agentsBefore ?? '', codexAgentsBlock());
  const configChanged = configBefore !== null && await writeChanged(configPath, configBefore, configAfter);
  const agentsChanged = agentsBefore !== null && await writeChanged(agentsPath, agentsBefore, agentsAfter);
  return { changed: configChanged || agentsChanged, configPath, agentsPath, created: [], updated: [] };
}

