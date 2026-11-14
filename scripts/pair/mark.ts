// `pnpm pair:mark <NNN> <working|waiting|blocked|idle|done> [note…]`  (PROMPTS 017)
// Writes only the calling seat's status file: one writer per file (PLAN §14.7).
// From MAIN, pass `--seat a|b`.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SEAT_STATES, readStatus, writeStatus, type SeatState, type SeatStatus } from './coord.js';
import { readPair, type Seat } from './lib.js';

const PROMPT_RE = /^\d{3}[a-z]?$/;

export function applyMark(status: SeatStatus, prompt: string, state: SeatState, note: string, now: Date): SeatStatus {
  if (!PROMPT_RE.test(prompt)) throw new Error(`Prompt must look like 094 or 073a (got "${prompt}")`);
  if (!SEAT_STATES.includes(state)) throw new Error(`State must be one of ${SEAT_STATES.join(', ')} (got "${state}")`);
  const done = state === 'done' && !status.done.includes(prompt) ? [...status.done, prompt] : status.done;
  return { ...status, prompt, state, note, since: now.toISOString(), done };
}

export function parseMarkArgs(args: readonly string[]): { seat?: Seat; prompt: string; state: SeatState; note: string } {
  const rest = [...args];
  let seat: Seat | undefined;
  const i = rest.indexOf('--seat');
  if (i >= 0) {
    const v = rest[i + 1];
    if (v !== 'a' && v !== 'b') throw new Error('--seat must be a or b');
    seat = v;
    rest.splice(i, 2);
  }
  const [prompt, state, ...note] = rest;
  if (!prompt || !state) throw new Error('Usage: pnpm pair:mark <NNN> <working|waiting|blocked|idle|done> [note…] [--seat a|b]');
  return { seat, prompt, state: state as SeatState, note: note.join(' ') };
}

async function main(): Promise<void> {
  const args = parseMarkArgs(process.argv.slice(2));
  const pair = readPair(process.cwd());
  if (!pair) throw new Error('Not in a pair-mode checkout. Run pnpm pair:setup in MAIN first.');
  const seat = pair.seat ?? args.seat;
  if (!seat) throw new Error('Run inside your worktree, or pass --seat a|b from MAIN.');
  if (pair.seat && args.seat && args.seat !== pair.seat) throw new Error(`You are Seat ${pair.seat.toUpperCase()}; you can only mark your own status.`);
  const next = applyMark(readStatus(pair.main, seat), args.prompt, args.state, args.note, new Date());
  writeStatus(pair.main, next);
  process.stdout.write(`Seat ${seat.toUpperCase()}: ${next.prompt} · ${next.state}${next.note ? ` · ${next.note}` : ''}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e: unknown) => {
    process.stderr.write(`pair:mark failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
