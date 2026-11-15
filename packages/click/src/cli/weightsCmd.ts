// PROMPTS 155: `click weights --show | --rollback` looks at what Click has learned about this repo, or undoes the last learning step.
//   click weights --show [--json] [--root <dir>]
//   click weights --rollback [--root <dir>]     the previous weights.json becomes current (a second rollback undoes the first)

import { resolve } from 'node:path';
import { WeightsFile } from '../../../core/src/learn/weights.js';
import { clickDir } from '../../../core/src/util/paths.js';
import { ClickClient } from '../client.js';
import { summarise, type WeightsSummary } from '../daemon/learner.js';
import { parseArgs } from './args.js';

export interface WeightsIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export const WEIGHTS_USAGE = 'usage: click weights --show [--json] | --rollback [--root <dir>]';

function describe(s: WeightsSummary): string {
  if (!s.version) return 'no learned weights yet (they appear after outcomes with a passing check are logged)';
  const L = [`weights ${s.version}: learned from ${s.events} outcome${s.events === 1 ? '' : 's'}, ${s.multipliers} edge multiplier${s.multipliers === 1 ? '' : 's'}, ${s.learnedEdges} learned co_changed edge${s.learnedEdges === 1 ? '' : 's'}${s.previous ? ` (previous: ${s.previous})` : ''}`];
  if (s.up.length) L.push('trusted more:', ...s.up.map((e) => `  ×${e.w.toFixed(2)}  ${e.key}`));
  if (s.down.length) L.push('trusted less:', ...s.down.map((e) => `  ×${e.w.toFixed(2)}  ${e.key}`));
  return L.join('\n');
}

export async function runWeights(argv: readonly string[], io: WeightsIo, cwd: string = process.cwd(), deps: { client?: ClickClient } = {}): Promise<number> {
  const p = parseArgs(argv, { show: 'bool', rollback: 'bool', json: 'bool', root: 'string' });
  if (p.error || p.positionals.length || (!!p.flags.show === !!p.flags.rollback)) {
    io.err(`${p.error ?? (p.positionals.length ? `unexpected argument ${p.positionals[0]}` : 'give exactly one of --show or --rollback')}\n${WEIGHTS_USAGE}`);
    return 2;
  }
  const root = resolve(cwd, p.flags.root ?? '.');
  const file = new WeightsFile(clickDir(root));

  if (p.flags.show) {
    const s = summarise(await file.load(), await file.loadPrevious());
    io.out(p.flags.json ? JSON.stringify(s, null, 2) : describe(s));
    return 0;
  }

  const r = await file.rollback();
  if (!r) {
    io.err('nothing to roll back to: there is no previous weights version');
    return 1;
  }
  io.out(`rolled back: ${r.from.version} -> ${r.to.version} (the replaced version is kept as the new previous, so a second rollback undoes this)`);
  const client = deps.client ?? new ClickClient({ root });
  if (await client.discover()) {
    try {
      await client.request('/weights/reload', { body: {}, deadlineMs: 5_000 });
      io.out('the running daemon is using them now');
    } catch (e) {
      io.err(`saved, but could not tell the running daemon (${e instanceof Error ? e.message : String(e)}); it uses them after a restart`);
    }
  } else io.out('no daemon is running: the next one starts with these weights');
  return 0;
}
