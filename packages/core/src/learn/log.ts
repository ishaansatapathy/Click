// PROMPTS 150 / SPEC §14: the append-only JSONL logs under `.click/` (contexts.jsonl, outcomes.jsonl). The learner derives its weights
// from these files alone, so they must survive crashes and concurrent writers:
//   - every event is ONE `write()` of one line on a handle opened with O_APPEND, so two processes (the daemon and a hook, say)
//     never interleave bytes within a line
//   - an event is never rewritten; a correction is a new event
//   - a reader skips a truncated last line (a crash mid-write) and any line that is not valid, and says how many it skipped
//   - every event carries a schema version `v`; lines of another version are skipped, not misread

import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export const LOG_VERSION = 1;
/** One event must stay a single atomic append: writes beyond this are refused instead of risking an interleaved line. */
export const MAX_EVENT_BYTES = 256 * 1024;

export class EventTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`log event is ${bytes} bytes (limit ${MAX_EVENT_BYTES})`);
    this.name = 'EventTooLargeError';
  }
}

export interface Versioned {
  v: number;
}

export interface ReadResult<T> {
  events: T[];
  /** The file ended in the middle of a line (a crash while writing): that last partial line was dropped. */
  truncatedTail: boolean;
  /** Complete lines that were not valid JSON, or not a JSON object. */
  corrupt: number;
  /** Valid lines of a schema version this code does not know, or that failed `validate`. */
  skipped: number;
}

/** A sortable, unique event id: `evt_<time in ms, base 36>_<6 random hex>`. */
export function newEventId(now: number = Date.now(), rand: () => string = () => randomBytes(3).toString('hex')): string {
  return `evt_${now.toString(36).padStart(9, '0')}_${rand()}`;
}

export interface EventLogOptions<T> {
  /** Extra check for a parsed event; return false to skip it (counted in `skipped`). */
  validate?: (value: unknown) => value is T;
}

export class EventLog<T extends Versioned> {
  private dirReady = false;
  private tailChecked = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly file: string,
    private readonly opts: EventLogOptions<T> = {},
  ) {}

  /** Append one event as one line. Appends from one instance are ordered; from several processes they are atomic per line. */
  append(event: T): Promise<void> {
    if (event.v !== LOG_VERSION) return Promise.reject(new Error(`log events must have v: ${LOG_VERSION}, got ${String(event.v)}`));
    const body = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
    if (body.length > MAX_EVENT_BYTES) return Promise.reject(new EventTooLargeError(body.length));
    const run = this.queue.then(async () => {
      if (!this.dirReady) {
        await mkdir(dirname(this.file), { recursive: true });
        this.dirReady = true;
      }
      // After a crash the file may end in the middle of a line. The first append of this process starts on a fresh line, so the
      // torn fragment stays one skippable line instead of swallowing the new event.
      let line = body;
      if (!this.tailChecked) {
        this.tailChecked = true;
        if (await endsMidLine(this.file)) line = Buffer.concat([Buffer.from('\n'), body]);
      }
      const fh = await open(this.file, 'a'); // O_APPEND
      try {
        let off = 0;
        while (off < line.length) off += (await fh.write(line, off, line.length - off)).bytesWritten; // normally exactly one write
      } finally {
        await fh.close();
      }
    });
    this.queue = run.catch(() => undefined); // one failed append must not block the ones after it
    return run;
  }

  async read(): Promise<ReadResult<T>> {
    return readEvents<T>(this.file, this.opts.validate);
  }
}

async function endsMidLine(file: string): Promise<boolean> {
  try {
    const size = (await stat(file)).size;
    if (size === 0) return false;
    const fh = await open(file, 'r');
    try {
      const b = Buffer.alloc(1);
      await fh.read(b, 0, 1, size - 1);
      return b[0] !== 0x0a;
    } finally {
      await fh.close();
    }
  } catch {
    return false; // no file yet
  }
}

export async function readEvents<T extends Versioned>(file: string, validate?: (value: unknown) => value is T): Promise<ReadResult<T>> {
  const out: ReadResult<T> = { events: [], truncatedTail: false, corrupt: 0, skipped: 0 };
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw e;
  }
  const endsClean = text.length === 0 || text.endsWith('\n');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (i === lines.length - 1 && !endsClean) out.truncatedTail = true; // the writer died mid-line
      else out.corrupt++;
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      out.corrupt++;
      continue;
    }
    if ((value as Versioned).v !== LOG_VERSION || (validate && !validate(value))) {
      out.skipped++;
      continue;
    }
    out.events.push(value as T);
  }
  return out;
}
