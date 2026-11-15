// PROMPTS 115: `click context "<task>"` prints what the agent would receive for that task.
//   click context "add a loading state to checkout" [--stdin] [--json] [--budget N] [--variant V] [--root <dir>]
// Starts the daemon if it is not running and waits for its graph to load (the first run indexes the repo).

import { resolve } from 'node:path';
import type { PackedContext } from '../../../core/src/types.js';
import { ClickClient, ClientError } from '../client.js';
import { parseArgs } from './args.js';

export interface ContextIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface ContextDeps {
  client?: ClickClient;
  readStdin?: () => Promise<string>;
  /** How long to wait for the daemon to start and load. */
  startWaitMs?: number;
}

export const CONTEXT_USAGE = 'usage: click context "<task>" [--stdin] [--json] [--budget N] [--variant V] [--root <dir>]';

export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function runContext(argv: readonly string[], io: ContextIo, cwd: string = process.cwd(), deps: ContextDeps = {}): Promise<number> {
  const p = parseArgs(argv, { stdin: 'bool', json: 'bool', budget: 'number', variant: 'string', root: 'string' });
  if (p.error) {
    io.err(`${p.error}\n${CONTEXT_USAGE}`);
    return 2;
  }
  const task = (p.flags.stdin ? await (deps.readStdin ?? readAllStdin)() : p.positionals.join(' ')).trim();
  if (!task) {
    io.err(`no task given\n${CONTEXT_USAGE}`);
    return 2;
  }
  const root = resolve(cwd, p.flags.root ?? '.');
  const client = deps.client ?? new ClickClient({ root });
  try {
    if (!(await client.discover())) io.err('starting the click daemon (the first run indexes the repo)…');
    await client.ensureRunning({ waitMs: deps.startWaitMs ?? 90_000, ready: true });
    const packed = await client.request<PackedContext>('/context', {
      body: { task, source: 'cli', ...(p.flags.budget ? { budgetTokens: p.flags.budget } : {}), ...(p.flags.variant ? { variant: p.flags.variant } : {}) },
      deadlineMs: 10_000,
    });
    if (p.flags.json) io.out(JSON.stringify(packed, null, 2));
    else {
      if (packed.text) io.out(packed.text);
      else io.err(`no context was produced${packed.degraded.length ? ` (degraded: ${packed.degraded.join(', ')})` : ''}`);
      io.err(`${packed.tokens}/${packed.budget} tokens · ${packed.items.length} items · ${Math.round(packed.timings.total ?? 0)} ms${packed.degraded.length ? ` · degraded: ${packed.degraded.join(', ')}` : ''}`);
    }
    return 0;
  } catch (e) {
    io.err(`click context: ${e instanceof ClientError ? e.message : e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
