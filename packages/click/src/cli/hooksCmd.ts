// PROMPTS 119 (G2 support): `click hooks install | uninstall | status` wires Click into Claude Code (and git) for one repo.
//   click hooks install [--root <dir>] [--local] [--git] [--no-stop]
//   click hooks uninstall [--root <dir>] [--local] [--git]
//   click hooks status [--root <dir>]
// --local writes .claude/settings.local.json (Claude Code keeps it out of git: right while the paths are machine specific).
// --git also installs the post-commit hook. `click init` (Lane A) will call the same functions.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defaultCliPath } from '../client.js';
import { defaultHookPaths, installClaudeHooks, InstallError, isClickCommand, uninstallClaudeHooks, type HookPaths, type SettingsFile } from '../install/claude.js';
import { GitHookError, installGitHook, uninstallGitHook } from '../install/githook.js';
import { isOptedIn } from '../hooks/hook-config.js';
import { parseArgs } from './args.js';

export interface HooksIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export const HOOKS_USAGE = 'usage: click hooks install|uninstall|status [--root <dir>] [--local] [--git] [--no-stop]';

export async function runHooks(argv: readonly string[], io: HooksIo, cwd: string = process.cwd(), deps: { paths?: HookPaths; cliPath?: string } = {}): Promise<number> {
  const [action, ...rest] = argv;
  const p = parseArgs(rest, { root: 'string', local: 'bool', git: 'bool', 'no-stop': 'bool' });
  if (!action || !['install', 'uninstall', 'status'].includes(action) || p.error || p.positionals.length) {
    io.err(`${p.error ?? (action ? `unexpected argument ${p.positionals[0] ?? action}` : 'no action given')}\n${HOOKS_USAGE}`);
    return 2;
  }
  const root = resolve(cwd, p.flags.root ?? '.');
  const file: SettingsFile = p.flags.local ? 'settings.local.json' : 'settings.json';
  const paths = deps.paths ?? defaultHookPaths();
  try {
    if (action === 'install') {
      if (!existsSync(paths.prompt)) {
        io.err(`the hook is not built yet (${paths.prompt}); run \`pnpm build\` in the click repo first`);
        return 1;
      }
      const r = await installClaudeHooks({ root, paths, file, ...(p.flags['no-stop'] ? { stop: false } : {}) });
      io.out(r.changed ? `Claude Code hooks ${r.created ? 'created' : 'updated'} in ${r.path}${r.backedUp ? ' (original saved as .click-bak)' : ''}: ${[...r.added, ...r.updated].join(', ')}` : `Claude Code hooks already installed in ${r.path}`);
      if (p.flags.git) {
        const g = await installGitHook({ root, cliPath: deps.cliPath ?? defaultCliPath() });
        io.out(g.changed ? `git post-commit hook installed in ${g.hooksDir}${g.chained.length ? ' (your existing hook still runs first)' : ''}` : 'git post-commit hook already installed');
      }
      return 0;
    }
    if (action === 'uninstall') {
      const r = await uninstallClaudeHooks({ root, file });
      io.out(r.changed ? `removed ${r.removed.join(', ')} hooks from ${r.path}` : `no Click hooks in ${r.path}`);
      if (p.flags.git) {
        const g = await uninstallGitHook({ root });
        io.out(g.removed.length || g.restored.length ? 'git post-commit hook removed' : 'no Click git hook found');
      }
      return 0;
    }
    // status
    let any = false;
    for (const f of ['settings.json', 'settings.local.json'] as const) {
      const path = join(root, '.claude', f);
      const text = await readFile(path, 'utf8').then((t) => t, () => null);
      if (text === null) continue;
      let settings: { hooks?: Record<string, { hooks?: { command?: unknown }[] }[]> };
      try {
        settings = JSON.parse(text.replace(/^﻿/, ''));
      } catch {
        io.out(`${f}: not valid JSON`);
        continue;
      }
      for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
        for (const g of groups) {
          for (const h of g.hooks ?? []) {
            if (!isClickCommand(h.command)) continue;
            any = true;
            const target = /"([^"]+)"/.exec(String(h.command))?.[1] ?? '';
            io.out(`${f}: ${event} -> ${h.command}${target && !existsSync(target) ? '   !! that file does not exist (run `pnpm build`)' : ''}`);
          }
        }
      }
    }
    if (!any) io.out('no Click hooks installed in this repo (run `click hooks install --local`)');
    io.out(`opted in: ${isOptedIn(root) ? 'yes (the hook acts in this repo)' : 'no (the hook ignores this repo; `click hooks install` opts it in)'}`);
    return 0;
  } catch (e) {
    if (e instanceof InstallError || e instanceof GitHookError) {
      io.err(e.message);
      return 1;
    }
    throw e;
  }
}
