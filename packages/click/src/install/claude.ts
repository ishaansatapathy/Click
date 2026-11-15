// PROMPTS 117 / SPEC §12.3: register Click's hooks in Claude Code's settings without disturbing anything else there.
// Claude Code's hooks schema, from its current docs:
//   { "hooks": { "<Event>": [ { "matcher"?: …, "hooks": [ { "type": "command", "command": "…", "timeout": <seconds> } ] } ] } }
// UserPromptSubmit and Stop take no matcher. Entries from all settings files are merged by Claude Code, never replaced.
// Our entries are recognised by their command: a path containing "click" and "dist/hooks/". The installer is idempotent:
//   no entry   -> ours is appended after the user's
//   same entry -> nothing changes, the file is not even rewritten
//   moved      -> the old entry is updated in place (no duplicates)
// The original file is copied to settings.json.click-bak before the first change, and a settings file that is not valid JSON is
// never touched.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../../../core/src/util/atomic.js';
import { OPT_IN_FILE } from '../hooks/hook-config.js';

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

export interface HookPaths {
  prompt: string;
  stop: string;
}

export type SettingsFile = 'settings.json' | 'settings.local.json';

export interface InstallOptions {
  /** The repo whose `.claude/` is edited. */
  root: string;
  paths?: HookPaths;
  /** `settings.json` (SPEC, shared with the team) or `settings.local.json` (gitignored: right when the paths are machine-specific). */
  file?: SettingsFile;
  /** Install the Stop hook. Default: only when its file exists (it is built by a later step). */
  stop?: boolean;
  timeoutSeconds?: number;
}

export interface InstallResult {
  path: string;
  changed: boolean;
  created: boolean;
  backedUp: boolean;
  added: string[];
  updated: string[];
  removed: string[];
}

const EVENTS = { prompt: 'UserPromptSubmit', stop: 'Stop' } as const;
type Kind = keyof typeof EVENTS;
const BACKUP_SUFFIX = '.click-bak';

const slash = (p: string): string => p.replace(/\\/g, '/');
const commandFor = (file: string): string => `node "${slash(resolve(file))}"`;

/** Is this hook command one of ours? (SPEC §12.3: a path containing `click` and `dist/hooks/`.) */
export function isClickCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  const c = slash(command).toLowerCase();
  return c.includes('click') && /dist\/hooks\/(prompt|stop)\.js/.test(c);
}
const kindOf = (command: string): Kind => (/dist\/hooks\/stop\.js/i.test(slash(command)) ? 'stop' : 'prompt');

/** Where the built hooks are: next to this module (dist/) or in the package's dist/ when running from source. */
export function defaultHookPaths(here: string = dirname(fileURLToPath(import.meta.url))): HookPaths {
  for (const dir of [join(here, 'hooks'), join(here, '..', '..', 'dist', 'hooks'), join(here, '..', 'dist', 'hooks')]) {
    if (existsSync(join(dir, 'prompt.js'))) return { prompt: join(dir, 'prompt.js'), stop: join(dir, 'stop.js') };
  }
  const dir = join(here, '..', '..', 'dist', 'hooks');
  return { prompt: join(dir, 'prompt.js'), stop: join(dir, 'stop.js') };
}

// ---------------------------------------------------------------- pure merge

interface HookEntry {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
  [k: string]: unknown;
}
interface Group {
  matcher?: unknown;
  hooks?: unknown;
  [k: string]: unknown;
}
type Settings = Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function eventGroups(settings: Settings, event: string, create: boolean): Group[] | null {
  if (settings.hooks === undefined) {
    if (!create) return null;
    settings.hooks = {};
  }
  if (!isObj(settings.hooks)) throw new InstallError('settings: "hooks" is not an object; fix it by hand first');
  const hooks = settings.hooks;
  if (hooks[event] === undefined) {
    if (!create) return null;
    hooks[event] = [];
  }
  if (!Array.isArray(hooks[event])) throw new InstallError(`settings: hooks.${event} is not an array; fix it by hand first`);
  return hooks[event] as Group[];
}

/** Add or update our hook entries in `settings` (mutates it). Returns what happened. */
export function mergeHooks(settings: Settings, want: { prompt?: string; stop?: string }, timeout = 3): { added: string[]; updated: string[] } {
  const added: string[] = [];
  const updated: string[] = [];
  for (const kind of ['prompt', 'stop'] as const) {
    const file = want[kind];
    if (!file) continue;
    const event = EVENTS[kind];
    const groups = eventGroups(settings, event, true)!;
    const command = commandFor(file);
    let found = false;
    for (const g of groups) {
      if (!isObj(g) || !Array.isArray(g.hooks)) continue;
      for (const h of g.hooks as HookEntry[]) {
        if (!isObj(h) || !isClickCommand(h.command) || kindOf(h.command as string) !== kind) continue;
        found = true;
        if (h.command !== command || h.type !== 'command' || h.timeout !== timeout) {
          h.type = 'command';
          h.command = command;
          h.timeout = timeout;
          updated.push(event);
        }
      }
    }
    if (!found) {
      groups.push({ hooks: [{ type: 'command', command, timeout }] });
      added.push(event);
    }
  }
  return { added, updated };
}

/** Remove our entries (and the groups, arrays and `hooks` object that only existed for them). */
export function removeHooks(settings: Settings): string[] {
  const removed: string[] = [];
  if (!isObj(settings.hooks)) return removed;
  const hooks = settings.hooks;
  for (const event of Object.values(EVENTS)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    for (const g of groups as Group[]) {
      if (!isObj(g) || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const entries = g.hooks as HookEntry[];
      const left = entries.filter((h) => !(isObj(h) && isClickCommand(h.command)));
      g.hooks = left;
      if (left.length !== entries.length) removed.push(event);
      if (left.length > 0 || entries.length === 0) kept.push(g); // a group we emptied goes away; a user's empty group stays
    }
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return removed;
}

// ---------------------------------------------------------------- files

interface Loaded {
  settings: Settings;
  existed: boolean;
  indent: string | number;
  raw: string;
  bom: boolean;
}

async function load(path: string): Promise<Loaded> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { settings: {}, existed: false, indent: 2, raw: '', bom: false };
    throw e;
  }
  const bom = raw.charCodeAt(0) === 0xfeff;
  const text = bom ? raw.slice(1) : raw;
  if (text.trim() === '') return { settings: {}, existed: true, indent: 2, raw, bom };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new InstallError(`${path} is not valid JSON (${e instanceof Error ? e.message : String(e)}); fix it by hand, nothing was changed`);
  }
  if (!isObj(parsed)) throw new InstallError(`${path} must contain a JSON object, nothing was changed`);
  const m = /^[ \t]*(?=")/m.exec(text.replace(/^{\s*\n/, '{\n'));
  const indent = m && m[0].length > 0 ? (m[0].startsWith('\t') ? '\t' : m[0].length) : 2;
  return { settings: parsed, existed: true, indent, raw, bom };
}

const serialise = (l: Loaded): string => `${l.bom ? '﻿' : ''}${JSON.stringify(l.settings, null, l.indent)}\n`;

async function backupOnce(path: string, existed: boolean): Promise<boolean> {
  const bak = path + BACKUP_SUFFIX;
  if (!existed || existsSync(bak)) return false;
  await copyFile(path, bak);
  return true;
}

/** The repo opts in to the hook by having `.click/enabled` (a bare `.click` is not enough); `.click/` must not be committed. */
export function ensureClickDir(root: string): void {
  try {
    mkdirSync(join(root, '.click'), { recursive: true });
    if (!existsSync(join(root, OPT_IN_FILE))) writeFileSync(join(root, OPT_IN_FILE), 'This repo uses Click: the prompt hook acts here. Remove this file (or run `click hooks uninstall`) to opt out.\n');
    const exclude = join(root, '.git', 'info', 'exclude');
    if (existsSync(join(root, '.git'))) {
      const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
      if (!/^\.click\/?$/m.test(text)) appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}.click/\n`);
    }
  } catch {
    // best effort: the daemon creates .click itself, and a missing exclude only means git status shows it
  }
}

export async function installClaudeHooks(o: InstallOptions): Promise<InstallResult> {
  const paths = o.paths ?? defaultHookPaths();
  const path = join(o.root, '.claude', o.file ?? 'settings.json');
  const loaded = await load(path);
  const withStop = o.stop ?? existsSync(paths.stop);
  const { added, updated } = mergeHooks(loaded.settings, { prompt: paths.prompt, ...(withStop ? { stop: paths.stop } : {}) }, o.timeoutSeconds ?? 3);
  await mkdir(o.root, { recursive: true });
  ensureClickDir(o.root);
  if (added.length === 0 && updated.length === 0) return { path, changed: false, created: false, backedUp: false, added, updated, removed: [] };
  const backedUp = await backupOnce(path, loaded.existed);
  await writeFileAtomic(path, serialise(loaded));
  return { path, changed: true, created: !loaded.existed, backedUp, added, updated, removed: [] };
}

export async function uninstallClaudeHooks(o: Pick<InstallOptions, 'root' | 'file'>): Promise<InstallResult> {
  const path = join(o.root, '.claude', o.file ?? 'settings.json');
  const loaded = await load(path);
  if (!loaded.existed) return { path, changed: false, created: false, backedUp: false, added: [], updated: [], removed: [] };
  const removed = removeHooks(loaded.settings);
  if (removed.length === 0) return { path, changed: false, created: false, backedUp: false, added: [], updated: [], removed };
  const backedUp = await backupOnce(path, true);
  await writeFileAtomic(path, serialise(loaded));
  return { path, changed: true, created: false, backedUp, added: [], updated: [], removed };
}
