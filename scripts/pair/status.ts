// `pnpm pair:status`  (PROMPTS 017, PLAN §14.6–14.7). Works from MAIN or from either worktree.
// Tells each seat what it is doing, what it may do next, and what it is waiting for.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SEATS, branchFor, readJson, readStatus, readStop, requestsDir, type PairJson, type SeatStatus } from './coord.js';
import { readPair, run, type Seat } from './lib.js';

export interface QueueEntry {
  prompt: string;
  waits?: string[];
  emits?: string[];
  gate?: string;
  ask?: boolean;
}

export interface Queues {
  preSplitTags: string[];
  a: QueueEntry[];
  b: QueueEntry[];
}

const here = dirname(fileURLToPath(import.meta.url));

export function loadQueues(file = join(here, 'queues.json')): Queues {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Queues>;
  return { preSplitTags: raw.preSplitTags ?? [], a: raw.a ?? [], b: raw.b ?? [] };
}

/** Prompt numbers per seat from commit subjects: "A/094: …" counts for seat A only; legacy "094: …" counts for both. */
export function parseDone(subjects: readonly string[]): { a: Set<string>; b: Set<string>; any: Set<string> } {
  const out = { a: new Set<string>(), b: new Set<string>(), any: new Set<string>() };
  for (const s of subjects) {
    const m = /^(?:([AB])\/)?(\d{3}[a-z]?):/.exec(s.trim());
    if (!m) continue;
    const prompt = m[2]!;
    if (m[1] === 'A') out.a.add(prompt);
    else if (m[1] === 'B') out.b.add(prompt);
    else out.any.add(prompt);
  }
  return out;
}

export interface NextInfo {
  next: QueueEntry | null; // first not-done entry whose waits are all satisfied
  head: QueueEntry | null; // first not-done entry overall
  headMissing: string[]; // waits the head entry is still missing
  remaining: number;
}

export function nextRunnable(queue: readonly QueueEntry[], done: ReadonlySet<string>, tags: ReadonlySet<string>): NextInfo {
  const pending = queue.filter((e) => !done.has(e.prompt));
  const head = pending[0] ?? null;
  const missing = (e: QueueEntry) => (e.waits ?? []).filter((w) => !tags.has(w));
  return {
    next: pending.find((e) => missing(e).length === 0) ?? null,
    head,
    headMissing: head ? missing(head) : [],
    remaining: pending.length,
  };
}

export interface RequestInfo {
  file: string;
  from: string;
  to: string;
  slug: string;
}

/** Open requests: files named <yyyymmdd-hhmm>-<from>-to-<to>-<slug>.md directly in coord/requests/. Oldest first. */
export function parseRequestName(file: string): RequestInfo | null {
  const m = /^(\d{8}-\d{4})-([a-z]+)-to-([a-z]+)-(.+)\.md$/i.exec(file);
  return m ? { file, from: m[2]!.toLowerCase(), to: m[3]!.toLowerCase(), slug: m[4]! } : null;
}

export function listRequests(main: string): RequestInfo[] {
  const dir = requestsDir(main);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map(parseRequestName)
    .filter((r): r is RequestInfo => r !== null)
    .sort((x, y) => x.file.localeCompare(y.file));
}

export interface StatusModel {
  main: string;
  me: Seat | null;
  stop: string | null;
  agents: Record<Seat, string>;
  seats: Record<Seat, { status: SeatStatus; ahead: number | null; next: NextInfo }>;
  tags: string[];
  requests: RequestInfo[];
  now: Date;
}

function ago(iso: string | null, now: Date): string {
  if (!iso) return '—';
  const min = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  return min < 60 ? `${min}m ago` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m ago`;
}

const label = (e: QueueEntry | null): string =>
  e ? `${e.prompt}${e.ask ? ' (ASK)' : ''}${e.gate ? ` (GATE ${e.gate})` : ''}${e.emits?.length ? ` → emits ${e.emits.join(', ')}` : ''}` : 'queue done';

export function renderStatus(m: StatusModel): string {
  const lines: string[] = [];
  lines.push(`Pair mode · MAIN ${m.main}${m.me ? ` · you are Seat ${m.me.toUpperCase()}` : ''}`);
  if (m.stop) lines.push('', `⛔ STOP: nobody integrates until coord/STOP is removed.`, `   ${m.stop.split('\n').join('\n   ')}`);
  lines.push('');
  for (const seat of SEATS) {
    const s = m.seats[seat];
    const you = m.me === seat ? '  ← you' : '';
    lines.push(`Seat ${seat.toUpperCase()} (${m.agents[seat]})${you}`);
    lines.push(`  now:   ${s.status.prompt ?? '—'} · ${s.status.state}${s.status.note ? ` · ${s.status.note}` : ''} · since ${ago(s.status.since, m.now)}`);
    lines.push(`  ahead of main: ${s.ahead ?? '?'} commit(s) · last integrated ${ago(s.status.lastIntegrated, m.now)}`);
    lines.push(`  next runnable: ${label(s.next.next)}`);
    if (s.next.head && s.next.headMissing.length) lines.push(`  queue head ${s.next.head.prompt} waits for: ${s.next.headMissing.join(', ')}`);
    lines.push(`  remaining in queue: ${s.next.remaining}`);
    const mine = m.requests.filter((r) => r.to === seat);
    if (mine.length) lines.push(`  ⚑ ${mine.length} open request(s) for Seat ${seat.toUpperCase()}: handle these before the queue`);
    lines.push('');
  }
  lines.push(`Sync tags: ${m.tags.length ? m.tags.join(', ') : 'none'}`);
  lines.push(`Open requests: ${m.requests.length ? '' : 'none'}`);
  for (const r of m.requests) lines.push(`  - ${r.file}${m.me && r.to === m.me ? '   ← for you' : ''}`);
  return lines.join('\n');
}

async function gitText(args: string[], cwd: string): Promise<string> {
  const r = await run('git', args, { cwd });
  return r.code === 0 ? r.stdout.trim() : '';
}

export async function collectStatus(cwd: string, now: Date = new Date()): Promise<StatusModel> {
  const pair = readPair(cwd);
  if (!pair) throw new Error('Not in a pair-mode checkout (no .pair.json or coord/pair.json). Run pnpm pair:setup in MAIN.');
  const main = pair.main;
  const pj = readJson<PairJson>(join(main, 'coord', 'pair.json'));
  const queues = loadQueues();
  const subjects = (await gitText(['log', '--format=%s', '--branches'], main)).split(/\r?\n/);
  const doneBy = parseDone(subjects);
  const tags = (await gitText(['tag', '-l'], main)).split(/\r?\n/).filter(Boolean);
  const tagSet = new Set([...tags, ...queues.preSplitTags]);

  const seats = {} as StatusModel['seats'];
  for (const seat of SEATS) {
    const status = readStatus(main, seat);
    const done = new Set([...doneBy[seat], ...doneBy.any, ...status.done]);
    const aheadText = await gitText(['rev-list', '--count', `main..${branchFor(seat)}`], main);
    seats[seat] = { status, ahead: aheadText === '' ? null : Number(aheadText), next: nextRunnable(queues[seat], done, tagSet) };
  }
  return {
    main,
    me: pair.seat,
    stop: readStop(main),
    agents: { a: pj?.seats.a.agent ?? 'seat a', b: pj?.seats.b.agent ?? 'seat b' },
    seats,
    tags: tags.filter((t) => /^(sync|gate|contract)\//.test(t)),
    requests: listRequests(main),
    now,
  };
}

async function main(): Promise<void> {
  process.stdout.write(renderStatus(await collectStatus(process.cwd())) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e: unknown) => {
    process.stderr.write(`pair:status failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
