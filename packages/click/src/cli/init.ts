// PROMPT 175: one-command project installation and its inverse.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { writeFileAtomic } from '../../../core/src/util/atomic.js';
import { ClickClient, defaultCliPath } from '../client.js';
import { OPT_IN_FILE } from '../hooks/hook-config.js';
import { installClaudeHooks, uninstallClaudeHooks, defaultHookPaths, type HookPaths } from '../install/claude.js';
import { installClaudeMcp, uninstallClaudeMcp } from '../install/claude-mcp.js';
import { installCodex, uninstallCodex } from '../install/codex.js';
import { installGitHook, uninstallGitHook } from '../install/githook.js';
import { parseArgs } from './args.js';
import { runIndex } from './indexCmd.js';
import { runPull } from './pull.js';

const exec = promisify(execFile);
const STATE = join('.click', 'install-state.json');

interface InstallState {
  v: 1;
  enabledCreated: boolean;
  excludeAdded: boolean;
  excludePath: string;
  excludeOriginal: string;
  claudeSettingsExisted: boolean;
  statuslineRequested: boolean;
}

export interface AgentPresence { claude: boolean; codex: boolean }
export interface InitPaths { cli: string; mcp: string; hooks: HookPaths }
export interface InitDeps {
  agents?: AgentPresence;
  paths?: InitPaths;
  pull?: typeof runPull;
  index?: typeof runIndex;
  startDaemon?: (root: string) => Promise<void>;
}

export interface InitIo { out(text: string): void; err(text: string): void }

export const INIT_USAGE = 'usage: click init [--dry-run] [--no-codex] [--no-githook] [--statusline]';
export const UNINSTALL_USAGE = 'usage: click uninstall [--dry-run]';

const readIf = (path: string): Promise<string | null> => readFile(path, 'utf8').then((text) => text, () => null);
const jsonObject = (text: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
};
const sameJson = (a: string, b: string): boolean => JSON.stringify(jsonObject(a)) === JSON.stringify(jsonObject(b));

async function gitRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd, windowsHide: true });
    return resolve(stdout.trim());
  } catch {
    throw new Error(`${cwd} is not inside a git repository`);
  }
}

async function commandExists(name: string): Promise<boolean> {
  try {
    await exec(process.platform === 'win32' ? 'where.exe' : 'which', [name], { windowsHide: true });
    return true;
  } catch { return false; }
}

async function detectAgents(root: string): Promise<AgentPresence> {
  const [claudeCommand, codexCommand] = await Promise.all([commandExists('claude'), commandExists('codex')]);
  return {
    claude: claudeCommand || existsSync(join(root, 'CLAUDE.md')) || existsSync(join(root, '.claude')),
    codex: codexCommand || existsSync(join(root, 'AGENTS.md')) || existsSync(join(root, '.codex')),
  };
}

function defaultPaths(): InitPaths {
  const cli = defaultCliPath();
  return { cli, mcp: join(dirname(cli), 'mcp.js'), hooks: defaultHookPaths() };
}

async function excludePath(root: string): Promise<string> {
  const { stdout } = await exec('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: root, windowsHide: true });
  const path = stdout.trim();
  return isAbsolute(path) ? path : resolve(root, path);
}

function addExclude(original: string): string {
  if (/^\.click\/?$/m.test(original)) return original;
  return `${original}${original && !original.endsWith('\n') ? '\n' : ''}.click/\n`;
}

function removeAddedExclude(current: string, original: string): string {
  const installed = addExclude(original);
  if (current === installed) return original;
  const lines = current.split(/(?<=\n)/);
  const index = lines.findIndex((line) => line.replace(/\r?\n$/, '') === '.click/');
  if (index >= 0) lines.splice(index, 1);
  return lines.join('');
}

async function loadState(root: string): Promise<InstallState | null> {
  const text = await readIf(join(root, STATE));
  if (!text) return null;
  const value = jsonObject(text) as Partial<InstallState> | null;
  return value?.v === 1 ? value as InstallState : null;
}

async function prepareState(root: string, statuslineRequested: boolean): Promise<InstallState> {
  const existing = await loadState(root);
  if (existing) return { ...existing, statuslineRequested: existing.statuslineRequested || statuslineRequested };
  const exclude = await excludePath(root);
  const excludeOriginal = await readIf(exclude) ?? '';
  const enabledCreated = !existsSync(join(root, OPT_IN_FILE));
  return {
    v: 1,
    enabledCreated,
    excludeAdded: addExclude(excludeOriginal) !== excludeOriginal,
    excludePath: exclude,
    excludeOriginal,
    claudeSettingsExisted: existsSync(join(root, '.claude', 'settings.json')),
    statuslineRequested,
  };
}

async function optIn(root: string, state: InstallState): Promise<void> {
  await mkdir(join(root, '.click'), { recursive: true });
  const enabled = join(root, OPT_IN_FILE);
  if (!existsSync(enabled)) await writeFileAtomic(enabled, 'This repo uses Click. Run `click uninstall` to remove the integration.\n');
  const current = await readIf(state.excludePath) ?? '';
  const next = addExclude(current);
  if (next !== current) await writeFileAtomic(state.excludePath, next);
  await writeFileAtomic(join(root, STATE), `${JSON.stringify(state, null, 2)}\n`);
}

async function restoreClaudeSettings(root: string, existed: boolean): Promise<void> {
  const path = join(root, '.claude', 'settings.json');
  const backup = `${path}.click-bak`;
  const current = await readIf(path);
  const original = await readIf(backup);
  if (!existed) {
    if (current !== null && Object.keys(jsonObject(current) ?? { notEmpty: true }).length === 0) await rm(path, { force: true });
  } else if (current !== null && original !== null && sameJson(current, original)) {
    await writeFileAtomic(path, original);
  }
  await rm(backup, { force: true });
}

export async function runInit(argv: readonly string[], io: InitIo, cwd = process.cwd(), deps: InitDeps = {}): Promise<number> {
  const parsed = parseArgs(argv, { 'dry-run': 'bool', 'no-codex': 'bool', 'no-githook': 'bool', statusline: 'bool' });
  if (parsed.error || parsed.positionals.length) {
    io.err(`${parsed.error ?? `unexpected argument ${parsed.positionals[0]}`}\n${INIT_USAGE}`);
    return 2;
  }
  try {
    const root = await gitRoot(cwd);
    const detected = deps.agents ?? await detectAgents(root);
    const agents = { claude: detected.claude, codex: detected.codex && !parsed.flags['no-codex'] };
    const paths = deps.paths ?? defaultPaths();
    if (parsed.flags['dry-run']) {
      io.out(`Would initialize Click in ${root}: ${agents.claude ? 'Claude' : 'no Claude'}; ${agents.codex ? 'Codex' : 'no Codex'}; ${parsed.flags['no-githook'] ? 'no git hook' : 'git hook'}; graph + daemon${parsed.flags.statusline ? '; statusline requested' : ''}`);
      return 0;
    }
    const state = await prepareState(root, Boolean(parsed.flags.statusline));
    await optIn(root, state);
    if (agents.claude) {
      await installClaudeHooks({ root, paths: paths.hooks });
      await installClaudeMcp({ root, mcpPath: paths.mcp });
    }
    if (agents.codex) await installCodex({ root, mcpPath: paths.mcp, promptHookPath: paths.hooks.prompt });
    if (!parsed.flags['no-githook']) await installGitHook({ root, cliPath: paths.cli });

    let pulled = false;
    try {
      pulled = await (deps.pull ?? runPull)(['--root', root], { out: (text) => io.out(text), err: () => undefined }, root) === 0;
    } catch { /* HydraDB is optional during init; build the local graph below. */ }
    if (!pulled) {
      io.out('No usable HydraDB graph; building the local index.');
      const code = await (deps.index ?? runIndex)(['--root', root], io, root);
      if (code !== 0) return code;
    }
    await (deps.startDaemon ?? (async (repo) => { await new ClickClient({ root: repo, cliPath: paths.cli }).ensureRunning({ waitMs: 90_000 }); }))(root);
    io.out(`Click initialized in ${root}: .click/enabled; ${agents.claude ? 'Claude hooks + MCP' : 'Claude not detected'}; ${agents.codex ? 'Codex hook + MCP' : 'Codex not detected'}; ${parsed.flags['no-githook'] ? 'no git hook' : 'git hook'}; daemon started.`);
    if (parsed.flags.statusline) io.out('Statusline requested; its settings entry is installed by the statusline component when available.');
    io.out('Undo with `click uninstall`.');
    return 0;
  } catch (error) {
    io.err(`click init: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export async function runUninstall(argv: readonly string[], io: InitIo, cwd = process.cwd()): Promise<number> {
  const parsed = parseArgs(argv, { 'dry-run': 'bool' });
  if (parsed.error || parsed.positionals.length) {
    io.err(`${parsed.error ?? `unexpected argument ${parsed.positionals[0]}`}\n${UNINSTALL_USAGE}`);
    return 2;
  }
  try {
    const root = await gitRoot(cwd);
    if (parsed.flags['dry-run']) {
      io.out(`Would remove Click's agent, MCP, hook and opt-in integration from ${root}; graph data stays in .click/.`);
      return 0;
    }
    const state = await loadState(root);
    await uninstallCodex({ root });
    await uninstallClaudeMcp({ root });
    await uninstallClaudeHooks({ root });
    await uninstallGitHook({ root });
    if (state) {
      await restoreClaudeSettings(root, state.claudeSettingsExisted);
      if (state.enabledCreated) await rm(join(root, OPT_IN_FILE), { force: true });
      if (state.excludeAdded) {
        const current = await readIf(state.excludePath) ?? '';
        await writeFileAtomic(state.excludePath, removeAddedExclude(current, state.excludeOriginal));
      }
      await rm(join(root, STATE), { force: true });
    } else {
      await rm(join(root, OPT_IN_FILE), { force: true });
    }
    io.out(`Click integration removed from ${root}; local graph/cache data was kept.`);
    return 0;
  } catch (error) {
    io.err(`click uninstall: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
