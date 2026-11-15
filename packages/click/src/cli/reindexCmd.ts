// PROMPTS 115: `click reindex [--changed] [paths...]` tells the running daemon to refresh its graph.
//   --changed (or no paths): the daemon asks git what changed. This is what the post-commit hook calls, so it must be quiet and
//   cheap: with no daemon running it does nothing (the next daemon start detects changes itself) and exits 0.

import { resolve } from 'node:path';
import { ClickClient, ClientError } from '../client.js';
import { parseArgs } from './args.js';

export interface ReindexIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export const REINDEX_USAGE = 'usage: click reindex [--changed] [--full] [--root <dir>] [paths...]';

export async function runReindex(argv: readonly string[], io: ReindexIo, cwd: string = process.cwd(), deps: { client?: ClickClient } = {}): Promise<number> {
  const p = parseArgs(argv, { changed: 'bool', full: 'bool', root: 'string' });
  if (p.error) {
    io.err(`${p.error}\n${REINDEX_USAGE}`);
    return 2;
  }
  const root = resolve(cwd, p.flags.root ?? '.');
  const client = deps.client ?? new ClickClient({ root });
  if (!(await client.discover())) {
    io.out('the click daemon is not running; changes are picked up when it starts');
    return 0;
  }
  try {
    const body = p.flags.full ? { full: true } : p.positionals.length && !p.flags.changed ? { paths: p.positionals.map((x) => resolve(cwd, x)) } : {};
    const r = await client.request<{ ok: boolean; queued: number }>('/reindex', { body, deadlineMs: 5_000 });
    io.out(p.flags.full ? 'full re-index queued' : r.queued > 0 ? `re-index queued (${r.queued} path${r.queued === 1 ? '' : 's'})` : 're-index queued (the daemon will ask git what changed)');
    return 0;
  } catch (e) {
    io.err(`click reindex: ${e instanceof ClientError ? e.message : String(e)}`);
    return 1;
  }
}
