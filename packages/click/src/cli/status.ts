// PROMPTS 115: `click status [--json]` shows whether the daemon is up and what it last did.

import { resolve } from 'node:path';
import { ClickClient, ClientError, type HealthBody } from '../client.js';
import type { Stats } from '../daemon/stats.js';
import { parseArgs } from './args.js';

export interface StatusIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export const STATUS_USAGE = 'usage: click status [--json] [--root <dir>]';

const dur = (ms: number): string => (ms < 1_000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1_000).toFixed(1)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

export async function runStatus(argv: readonly string[], io: StatusIo, cwd: string = process.cwd(), deps: { client?: ClickClient } = {}): Promise<number> {
  const p = parseArgs(argv, { json: 'bool', root: 'string' });
  if (p.error || p.positionals.length) {
    io.err(`${p.error ?? `unexpected argument ${p.positionals[0]}`}\n${STATUS_USAGE}`);
    return 2;
  }
  const root = resolve(cwd, p.flags.root ?? '.');
  const client = deps.client ?? new ClickClient({ root });
  if (!(await client.discover())) {
    io.out(p.flags.json ? JSON.stringify({ running: false }) : `click daemon: not running (start it with \`click serve\`, or run any \`click context "<task>"\`)`);
    return 0;
  }
  try {
    const health = await client.request<HealthBody & { uptimeMs: number; bootSource: string | null; bootMs: number; weightsVersion: string | null; hydra: { ok: boolean; version?: string; detail?: string } }>('/health', { deadlineMs: 2_000 });
    const stats = await client.request<Stats>('/stats', { deadlineMs: 2_000 });
    if (p.flags.json) {
      io.out(JSON.stringify({ running: true, health, stats }, null, 2));
      return 0;
    }
    const L: string[] = [];
    L.push(`click daemon ${health.version}: ${health.status}, up ${dur(health.uptimeMs)}${health.bootSource ? ` (booted from ${health.bootSource} in ${dur(health.bootMs)})` : ''}`);
    L.push(`graph:   ${health.graphVersion ?? 'not loaded'} · ${health.nodes} nodes · ${health.edges} edges${health.weightsVersion ? ` · learned weights ${health.weightsVersion}` : ''}`);
    L.push(`hydradb: ${health.hydra.ok ? `ok${health.hydra.version ? ` (${health.hydra.version})` : ''}` : `unavailable${health.hydra.detail ? ` (${health.hydra.detail})` : ''}: serving from the local replica`}`);
    L.push(`served:  ${stats.totals.contexts} context${stats.totals.contexts === 1 ? '' : 's'}, ${stats.totals.tokens} tokens in total`);
    if (stats.last) L.push(`last:    ${stats.last.tokens} tokens · ${stats.last.files} files · ${stats.last.ms} ms · pruner ${stats.last.pruner}${stats.last.degraded.length ? ` · degraded: ${stats.last.degraded.join(', ')}` : ''} · ${stats.last.ts}`);
    io.out(L.join('\n'));
    return 0;
  } catch (e) {
    io.err(`click status: ${e instanceof ClientError ? e.message : String(e)}`);
    return 1;
  }
}
